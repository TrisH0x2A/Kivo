#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod http;
mod storage;

use http::client::{
    cancel_http_request, cancel_oauth_exchange, clear_cookie_jar, delete_cookie_jar_entry,
    get_cookie_jar, oauth_exchange_token, reflect_grpc_server, send_grpc_request, send_http_request,
    upsert_cookie_jar_entry,
    wait_for_oauth_callback,
};
use http::load_test::{run_load_test, cancel_load_test};
use http::realtime::{
    realtime_connect_websocket, realtime_send, realtime_disconnect, realtime_connect_sse,
    realtime_connect_socketio, realtime_emit_socketio,
};
use storage::{
    create_workspace_environment_cmd,
    delete_workspace_environment_cmd,
    export_collection_file, export_request_file, export_response_file,
    get_app_config, get_app_settings, get_default_storage_path, get_env_vars,
    get_workspace_environments_cmd,
    get_resolved_storage_path,
    get_collection_config, import_collection_file, import_request_file, load_app_state, open_config_directory, reveal_item, save_app_state,
    parse_grpc_proto_file, list_grpc_proto_files_in_directory,
    save_collection_config, save_env_vars, set_active_workspace_environment_cmd, set_app_settings, set_storage_path, switch_storage_path,
    validate_storage_path,
};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            send_http_request,
            send_grpc_request,
            reflect_grpc_server,
            cancel_http_request,
            get_cookie_jar,
            delete_cookie_jar_entry,
            clear_cookie_jar,
            upsert_cookie_jar_entry,
            oauth_exchange_token,
            wait_for_oauth_callback,
            cancel_oauth_exchange,
            load_app_state,
            save_app_state,
            open_config_directory,
            reveal_item,
            get_app_config,
            get_app_settings,
            set_app_settings,
            set_storage_path,
            validate_storage_path,
            switch_storage_path,
            get_default_storage_path,
            get_env_vars,
            save_env_vars,
            get_workspace_environments_cmd,
            create_workspace_environment_cmd,
            set_active_workspace_environment_cmd,
            delete_workspace_environment_cmd,
            get_collection_config,
            save_collection_config,
            get_resolved_storage_path,
            import_collection_file,
            import_request_file,
            parse_grpc_proto_file,
            list_grpc_proto_files_in_directory,
            export_collection_file,
            export_request_file,
            export_response_file,
            run_load_test,
            cancel_load_test,
            realtime_connect_websocket,
            realtime_send,
            realtime_disconnect,
            realtime_connect_sse,
            realtime_connect_socketio,
            realtime_emit_socketio,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

