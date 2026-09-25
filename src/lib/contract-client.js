export function validateContract(value, schema) {
  return new Promise((resolve) => {
    let worker;
    let timer;
    const finish = (result) => {
      clearTimeout(timer);
      worker?.terminate();
      resolve(result);
    };
    try {
      worker = new Worker(new URL("./contract-worker.js", import.meta.url), { type: "module" });
      timer = setTimeout(() => finish({ ok: false, errors: ["Validation stopped after 5 seconds."] }), 5000);
      worker.onmessage = ({ data }) => finish(data);
      worker.onerror = () => finish({ ok: false, errors: ["The contract validation worker failed."] });
      worker.postMessage({ value, schema });
    } catch (error) {
      finish({ ok: false, errors: [String(error.message || error)] });
    }
  });
}
