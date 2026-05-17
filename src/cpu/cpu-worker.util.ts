import { join } from 'path';
import { Worker } from 'worker_threads';

export function runFibonacciWorker(number: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(__dirname, 'workers', 'fibonacci.worker.js'), {
      workerData: { number },
    });

    worker.once('message', (message: { result?: number; error?: string }) => {
      if (typeof message.result === 'number') {
        resolve(message.result);
        return;
      }

      reject(new Error(message.error || 'Worker returned an invalid result.'));
    });

    worker.once('error', reject);

    worker.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Fibonacci worker stopped with exit code ${code}.`));
      }
    });
  });
}
