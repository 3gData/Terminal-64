type Callback = (data: any) => void;

interface Subscriber {
  widgetId: string;
  callback: Callback;
}

class WidgetBus {
  private topics = new Map<string, Subscriber[]>();

  subscribe(topic: string, widgetId: string, callback: Callback) {
    let subs = this.topics.get(topic);
    if (!subs) {
      subs = [];
      this.topics.set(topic, subs);
    }
    // Prevent duplicate subscription
    if (!subs.some((s) => s.widgetId === widgetId)) {
      subs.push({ widgetId, callback });
    }
  }

  unsubscribe(topic: string, widgetId: string) {
    const subs = this.topics.get(topic);
    if (subs) {
      const filtered = subs.filter((s) => s.widgetId !== widgetId);
      if (filtered.length === 0) this.topics.delete(topic);
      else this.topics.set(topic, filtered);
    }
  }

  unsubscribeAll(widgetId: string) {
    for (const [topic, subs] of this.topics) {
      const filtered = subs.filter((s) => s.widgetId !== widgetId);
      if (filtered.length === 0) this.topics.delete(topic);
      else this.topics.set(topic, filtered);
    }
  }

  broadcast(topic: string, data: any, senderWidgetId: string) {
    const subs = this.topics.get(topic);
    if (!subs) return;
    for (const sub of subs) {
      if (sub.widgetId !== senderWidgetId) {
        try { sub.callback(data); } catch {}
      }
    }
  }
}

export const widgetBus = new WidgetBus();
