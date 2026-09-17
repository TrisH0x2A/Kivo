export function createSaveQueue() {
  let tail = Promise.resolve();
  return {
    enqueue(operation) {
      const result = tail.then(operation);
      tail = result.catch(() => {});
      return result;
    },
    flush() {
      return tail;
    },
  };
}
