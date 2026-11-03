// Session store: remembers where each user is in the menu.
// In-memory is fine for a demo (sessions reset when the server restarts).
// To scale, write a RedisStore with the same async get/set/delete methods
// and pass it to the engine instead — nothing else changes.

class MemoryStore {
  constructor({ ttlMinutes = 30 } = {}) {
    this.ttlMs = ttlMinutes * 60 * 1000;
    this.map = new Map();
  }

  async get(userId) {
    const entry = this.map.get(userId);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
      this.map.delete(userId);
      return null;
    }
    return entry.value;
  }

  // ttlMinutes (optional) overrides the default, e.g. the flow's own session timeout.
  async set(userId, value, ttlMinutes) {
    const ttl = ttlMinutes ? ttlMinutes * 60 * 1000 : this.ttlMs;
    this.map.set(userId, { value, expires: Date.now() + ttl });
  }

  async delete(userId) {
    this.map.delete(userId);
  }
}

module.exports = { MemoryStore };
