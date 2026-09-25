import { validateJsonAgainstSchema } from "./contract-validation.js";

self.onmessage = async ({ data }) => {
  self.postMessage(await validateJsonAgainstSchema(data.value, data.schema));
};
