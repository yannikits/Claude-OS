import { describe, expect, it } from 'vitest';
import { createNotificationBus } from '../../src/server/events-sse.js';

describe('createNotificationBus', () => {
  it('starts with zero subscribers', () => {
    const bus = createNotificationBus();
    expect(bus.subscriberCount()).toBe(0);
  });

  it('delivers an emit to every subscriber', () => {
    const bus = createNotificationBus();
    const a: Array<[string, unknown]> = [];
    const b: Array<[string, unknown]> = [];
    bus.subscribe((m, p) => a.push([m, p]));
    bus.subscribe((m, p) => b.push([m, p]));
    bus.emit('schedule://event', { id: 'x' });
    expect(a).toEqual([['schedule://event', { id: 'x' }]]);
    expect(b).toEqual([['schedule://event', { id: 'x' }]]);
  });

  it('unsubscribe stops further deliveries', () => {
    const bus = createNotificationBus();
    const collected: string[] = [];
    const unsub = bus.subscribe((m) => collected.push(m));
    bus.emit('a', null);
    unsub();
    bus.emit('b', null);
    expect(collected).toEqual(['a']);
    expect(bus.subscriberCount()).toBe(0);
  });

  it('a throwing subscriber does not affect siblings', () => {
    const bus = createNotificationBus();
    const ok: string[] = [];
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe((m) => ok.push(m));
    bus.emit('z', null);
    expect(ok).toEqual(['z']);
  });
});
