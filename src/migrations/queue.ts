import { config } from "@/config";
import { recoverInterrupted, runMigration } from "./engine";

// Antrean job migrasi. REDIS_URL ada (Railway) → BullMQ (bisa dipisah ke service worker: RUN_WORKER=false di API).
// Tanpa Redis (dev/tes) → runner in-process. Status sebenarnya selalu di Postgres; antrean hanya pemicu,
// dan runMigration hanya mengambil migrasi berstatus "queued" sehingga pemicu ganda aman.

type Runner = { enqueue(id: string): Promise<void>; close(): Promise<void> };
let runner: Runner | null = null;
const MAX_PARALLEL_JOBS = 2;

function inProcess(): Runner {
  const running = new Set<string>();
  const waiting: string[] = [];
  const pump = () => {
    while (running.size < MAX_PARALLEL_JOBS && waiting.length) {
      const id = waiting.shift()!;
      if (running.has(id)) continue;
      running.add(id);
      void runMigration(id)
        .catch((e) => console.error("[worker]", e instanceof Error ? e.message : e))
        .finally(() => {
          running.delete(id);
          pump();
        });
    }
  };
  return {
    async enqueue(id) {
      if (!waiting.includes(id)) waiting.push(id);
      setImmediate(pump);
    },
    async close() {
      waiting.length = 0;
    },
  };
}

async function bull(): Promise<Runner> {
  const { Queue, Worker } = await import("bullmq");
  const connection = { url: config.redisUrl, maxRetriesPerRequest: null };
  const queue = new Queue("migrations", { connection });
  const worker = config.runWorker
    ? new Worker("migrations", async (job) => runMigration(job.data.id as string), { connection, concurrency: MAX_PARALLEL_JOBS })
    : null;
  worker?.on("failed", (job, err) => console.error("[worker] job", job?.id, err.message));
  return {
    async enqueue(id) {
      // jobId unik per pemicu; runMigration sendiri yang mencegah eksekusi ganda
      await queue.add("run", { id }, { jobId: `${id}-${Date.now()}`, removeOnComplete: 100, removeOnFail: 100 });
    },
    async close() {
      await worker?.close();
      await queue.close();
    },
  };
}

export async function startQueue() {
  runner = config.redisUrl ? await bull() : inProcess();
  if (config.runWorker || !config.redisUrl) {
    for (const id of await recoverInterrupted()) await runner.enqueue(id);
  }
  console.log(`[queue] ${config.redisUrl ? "BullMQ (Redis)" : "in-process"}${config.runWorker ? " + worker" : ""}`);
}

export async function enqueueMigration(id: string) {
  if (!runner) runner = inProcess();
  await runner.enqueue(id);
}

export async function closeQueue() {
  await runner?.close();
}
