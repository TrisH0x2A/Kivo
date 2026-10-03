import { validateContract } from "./contract-client.js";

export function compareResponsesAsync(left, right, rules) {
  return new Promise((resolve, reject) => {
    let worker, timer;
    const finish = (result, error) => {
      clearTimeout(timer); worker?.terminate();
      if (error) reject(new Error(error)); else resolve(result);
    };
    try {
      worker = new Worker(new URL("./response-diff-worker.js", import.meta.url), { type: "module" });
      timer = setTimeout(() => finish(null, "Comparison stopped after 5 seconds."), 5000);
      worker.onmessage = ({ data }) => finish(data.result, data.error);
      worker.onerror = () => finish(null, "The comparison worker failed.");
      // Transport captures contain private inputs; the comparison worker does not need them.
      const snapshot = ({ status, durationMs, body, rawBody, isBinary, bodyBase64, headers }) => ({ status, durationMs, body, rawBody, isBinary, bodyBase64, headers });
      worker.postMessage({ left: snapshot(left), right: snapshot(right), rules });
    } catch (error) { finish(null, String(error.message || error)); }
  });
}

export async function checkComparisonContract(response, contract, validate = validateContract) {
  const status = String(response?.status || 0);
  const schema = contract?.responses?.[status] ?? contract?.responses?.[`${status[0]}XX`] ?? contract?.responses?.default;
  if (schema === undefined) return { checked: false, ok: false, errors: [`No saved contract for status ${status}.`] };
  if (response.isBinary) return { checked: false, ok: false, errors: ["JSON contracts cannot validate binary responses."] };
  try {
    return { checked: true, ...await validate(JSON.parse(response.rawBody ?? response.body), schema) };
  } catch (error) { return { checked: true, ok: false, errors: [String(error.message || error)] }; }
}
