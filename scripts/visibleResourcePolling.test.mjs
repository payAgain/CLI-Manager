import test from "node:test";
import assert from "node:assert/strict";
import { createVisibleResourcePoller } from "../src/lib/visibleResourcePolling.ts";

function fixture(overrides = {}) {
  const samples = [], errors = [], loading = [];
  const poller = createVisibleResourcePoller({
    isVisible: async () => true, read: async () => "sample",
    onSnapshot: value => samples.push(value), onError: error => errors.push(error),
    onLoading: value => loading.push(value), ...overrides,
  });
  return { poller, samples, errors, loading };
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test("hidden or minimized windows skip resource reads and resume on visibility", async () => {
  let visible = false, reads = 0;
  const f = fixture({ isVisible: async () => visible, read: async () => ++reads });
  await f.poller.refresh(true);
  assert.equal(reads, 0);
  visible = true;
  await f.poller.refresh(true);
  assert.deepEqual(f.samples, [1]);
});

test("manual refresh and timer ticks share one in-flight resource read", async () => {
  const read = deferred(); let reads = 0;
  const f = fixture({ read: () => { reads++; return read.promise; } });
  const first = f.poller.refresh(true);
  await Promise.resolve();
  await f.poller.refresh();
  assert.equal(reads, 1);
  read.resolve("fresh"); await first;
  assert.deepEqual(f.samples, ["fresh"]);
  assert.deepEqual(f.loading, [true, false]);
});

test("closing a view cannot let its late sample replace a reopened view", async () => {
  const read = deferred(), samples = [];
  const old = fixture({ read: () => read.promise, onSnapshot: value => samples.push(value) });
  const pending = old.poller.refresh(true);
  await Promise.resolve(); old.poller.dispose();
  const reopened = fixture({ read: async () => "new", onSnapshot: value => samples.push(value) });
  await reopened.poller.refresh(true);
  read.resolve("old"); await pending;
  assert.deepEqual(samples, ["new"]);
  assert.deepEqual(old.loading, [true]);
});

test("closing during an asynchronous window visibility check never starts sampling", async () => {
  const visible = deferred(); let reads = 0;
  const f = fixture({ isVisible: () => visible.promise, read: async () => ++reads });
  const pending = f.poller.refresh(); f.poller.dispose();
  visible.resolve(true); await pending;
  assert.equal(reads, 0);
});

test("sampling failure releases the request so a later refresh can recover", async () => {
  let failed = true;
  const f = fixture({ read: async () => { if (failed) throw new Error("unavailable"); return "recovered"; } });
  await f.poller.refresh(true); failed = false; await f.poller.refresh(true);
  assert.equal(f.errors.length, 1);
  assert.deepEqual(f.samples, ["recovered"]);
  assert.deepEqual(f.loading, [true, false, true, false]);
});
