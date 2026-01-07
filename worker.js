const { parentPort } = require("worker_threads");

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

(async () => {
  console.log("Worker: started");

  await sleep(3000); // sleep for 3 seconds

  console.log("Worker: finished after sleep");

  // optional: notify parent
  if (parentPort) {
    parentPort.postMessage("done");
  }
})();
