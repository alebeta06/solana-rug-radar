/**
 * Bounded buffer between the stream (producer) and the rest of the system (consumer).
 *
 * Backpressure policy: DROP BY PRIORITY, never "stop reading".
 * A WebSocket firehose cannot be paused: if we stop reading, the server buffers for a while
 * and then disconnects us, and the reconnect backfill only recovers the last 200 events per
 * type (~0.5 s of swaps). Pausing therefore loses data anyway, but uncontrolled and silently.
 * Dropping is explicit, counted, and chooses WHAT is lost:
 *
 * - critical (token_create, pool_create, graduation): ~1/s, the primary signal. Dropped last.
 * - normal (liquidity, meme, metadata): tens per second.
 * - bulk (swap, transfer, anything unlisted): ~900/s. Dropped first.
 *
 * When full, the oldest event of the least important non-empty class is evicted to make room;
 * if everything queued is more important than the incoming event, the incoming one is dropped.
 * Delivery stays in arrival order across classes (global sequence number), so priority only
 * decides what is lost, never reorders what is delivered.
 */

export type Priority = 'critical' | 'normal' | 'bulk';

const RANK: Record<Priority, number> = { bulk: 0, normal: 1, critical: 2 };
const LOW_TO_HIGH: readonly Priority[] = ['bulk', 'normal', 'critical'];

/** FIFO with O(1) shift (array + moving head, compacted when half is dead space). */
class Fifo<T> {
  private items: T[] = [];
  private head = 0;

  get length(): number {
    return this.items.length - this.head;
  }

  push(item: T): void {
    this.items.push(item);
  }

  peek(): T | undefined {
    return this.items[this.head];
  }

  shift(): T | undefined {
    if (this.head >= this.items.length) return undefined;
    const item = this.items[this.head];
    this.head += 1;
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return item;
  }
}

interface Entry<T> {
  readonly seq: number;
  readonly item: T;
}

export class EventQueue<T> {
  private readonly classes: Record<Priority, Fifo<Entry<T>>> = {
    bulk: new Fifo(),
    normal: new Fifo(),
    critical: new Fifo(),
  };
  private size = 0;
  private seq = 0;
  private ended = false;
  private waiter: ((result: IteratorResult<T>) => void) | undefined;

  constructor(
    private readonly capacity: number,
    private readonly priorityOf: (item: T) => Priority,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('EventQueue capacity must be >= 1');
  }

  get length(): number {
    return this.size;
  }

  /** Adds an item. Returns the item that was dropped to respect the capacity, if any. */
  push(item: T): T | undefined {
    if (this.ended) return item;
    if (this.waiter !== undefined) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ done: false, value: item });
      return undefined;
    }
    const priority = this.priorityOf(item);
    let dropped: T | undefined;
    if (this.size >= this.capacity) {
      const victimClass = LOW_TO_HIGH.find((p) => this.classes[p].length > 0);
      if (victimClass === undefined || RANK[victimClass] > RANK[priority]) return item;
      dropped = this.classes[victimClass].shift()?.item;
      this.size -= 1;
    }
    this.classes[priority].push({ seq: this.seq++, item });
    this.size += 1;
    return dropped;
  }

  /** Next item in arrival order; waits if empty; `done` once ended and drained. */
  next(): Promise<IteratorResult<T>> {
    let oldest: Fifo<Entry<T>> | undefined;
    for (const p of LOW_TO_HIGH) {
      const head = this.classes[p].peek();
      if (head !== undefined && (oldest === undefined || head.seq < oldest.peek()!.seq)) {
        oldest = this.classes[p];
      }
    }
    if (oldest !== undefined) {
      this.size -= 1;
      return Promise.resolve({ done: false, value: oldest.shift()!.item });
    }
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  /** No more pushes; a waiting consumer is released once the queue is drained. */
  end(): void {
    this.ended = true;
    if (this.waiter !== undefined) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ done: true, value: undefined });
    }
  }
}
