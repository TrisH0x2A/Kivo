import { compareResponses } from "./response-diff.js";

self.onmessage = ({ data }) => {
  try { self.postMessage({ result: compareResponses(data.left, data.right, data.rules) }); }
  catch (error) { self.postMessage({ error: String(error.message || error) }); }
};
