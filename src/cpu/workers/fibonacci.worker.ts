import { parentPort, workerData } from 'worker_threads';

function fibonacci(number: number): number {
  if (number <= 1) {
    return number;
  }

  return fibonacci(number - 1) + fibonacci(number - 2);
}

try {
  parentPort?.postMessage({ result: fibonacci(workerData.number) });
} catch (error) {
  parentPort?.postMessage({
    error: error instanceof Error ? error.message : 'Unknown worker error',
  });
}
