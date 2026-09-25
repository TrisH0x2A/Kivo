use super::*;

#[test]
fn descriptor_tools_report_fields_and_validate_without_transport() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../mock-servers/protos/book_service.proto");
    let pool = compile_descriptor_pool(path).unwrap();
    let service = pool.services().next().unwrap();
    let method = service.methods().next().unwrap();
    let key = format!("{}/{}", service.full_name(), method.name());
    let result = inspect_method(path, &key, Some(r#"{"definitelyUnknownField":1}"#)).unwrap();
    assert_eq!(result["inputType"], method.input().full_name());
    assert!(result["fields"].is_array());
    assert!(result["validationError"].is_string());
    let example = result["example"].to_string();
    assert!(inspect_method(path, &key, Some(&example)).unwrap()["validationError"].is_null());
}
use tonic::codegen::{http, Body, BoxFuture, Service, StdError};
use std::task::{Context, Poll};

#[derive(Clone)]
struct EchoServer(DynamicCodec);
impl tonic::server::NamedService for EchoServer { const NAME: &'static str = "book.BookService"; }
struct Echo;
type Messages = std::pin::Pin<Box<dyn futures_util::Stream<Item = Result<DynamicMessage, Status>> + Send>>;
impl tonic::server::StreamingService<DynamicMessage> for Echo {
    type Response = DynamicMessage;
    type ResponseStream = Messages;
    type Future = BoxFuture<tonic::Response<Messages>, Status>;
    fn call(&mut self, request: Request<tonic::Streaming<DynamicMessage>>) -> Self::Future {
        Box::pin(async move {
            let mut response = tonic::Response::new(Box::pin(request.into_inner()) as Messages);
            response.metadata_mut().insert("x-test", "live".parse().unwrap());
            Ok(response)
        })
    }
}
impl<B> Service<http::Request<B>> for EchoServer
where B: Body + Send + 'static, B::Error: Into<StdError> + Send + 'static {
    type Response = http::Response<tonic::body::BoxBody>;
    type Error = std::convert::Infallible;
    type Future = BoxFuture<Self::Response, Self::Error>;
    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> { Poll::Ready(Ok(())) }
    fn call(&mut self, request: http::Request<B>) -> Self::Future {
        let codec = self.0.clone();
        Box::pin(async move { Ok(tonic::server::Grpc::new(codec).streaming(Echo, request).await) })
    }
}

fn descriptor() -> prost_reflect::MessageDescriptor {
    compile_descriptor_pool(concat!(env!("CARGO_MANIFEST_DIR"), "/../mock-servers/protos/book_service.proto"))
        .unwrap().get_message_by_name("book.Book").unwrap()
}

#[test]
fn validates_message_shapes_against_descriptors() {
    let descriptor = descriptor();
    assert!(initial_messages(descriptor.clone(), "[]", false).is_err());
    assert!(initial_messages(descriptor.clone(), "[]", true).unwrap().is_empty());
    assert_eq!(initial_messages(descriptor.clone(), r#"[{"title":"one"},{"title":"two"}]"#, true).unwrap().len(), 2);
    assert!(parse_message(descriptor, r#"{"unknownField":1}"#).is_err());
}

#[tokio::test]
async fn sends_incremental_messages_and_half_closes_over_http2() {
    use futures_util::StreamExt;
    let descriptor = descriptor();
    let codec = DynamicCodec::new(descriptor.clone(), descriptor.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let incoming = futures_util::stream::unfold(listener, |listener| async move {
        Some((listener.accept().await.map(|(socket, _)| socket), listener))
    });
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    let server_codec = codec.clone();
    let server = tokio::spawn(async move {
        tonic::transport::Server::builder().add_service(EchoServer(server_codec))
            .serve_with_incoming_shutdown(incoming, async { let _ = stop_rx.await; }).await.unwrap();
    });
    let channel = Endpoint::from_shared(format!("http://{addr}")).unwrap().connect().await.unwrap();
    let mut client = tonic::client::Grpc::new(channel);
    client.ready().await.unwrap();
    let (sender, receiver) = mpsc::channel(4);
    let outgoing = futures_util::stream::unfold(receiver, |mut rx| async { rx.recv().await.map(|message| (message, rx)) });
    sender.send(parse_message(descriptor.clone(), r#"{"title":"first"}"#).unwrap()).await.unwrap();
    let response = client.streaming(Request::new(outgoing), "/book.BookService/Echo".parse().unwrap(), codec).await.unwrap();
    assert_eq!(response.metadata().get("x-test").unwrap(), "live");
    let mut stream = response.into_inner();
    let first = timeout(Duration::from_secs(2), stream.next()).await.unwrap().unwrap().unwrap();
    assert_eq!(serde_json::to_value(first).unwrap()["title"], "first");
    sender.send(parse_message(descriptor, r#"{"title":"second"}"#).unwrap()).await.unwrap();
    drop(sender);
    let second = stream.message().await.unwrap().unwrap();
    assert_eq!(serde_json::to_value(second).unwrap()["title"], "second");
    assert!(stream.message().await.unwrap().is_none());
    let _ = stop_tx.send(());
    drop(stream);
    drop(client);
    timeout(Duration::from_secs(3), server).await.unwrap().unwrap();
}
