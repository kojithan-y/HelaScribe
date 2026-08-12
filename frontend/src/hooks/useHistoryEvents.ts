import { useEffect } from "react";

import { HISTORY_WS_URL } from "../api";
import type { TranscriptRecord } from "../types";

export function useHistoryEvents(
  onRecord: (record: TranscriptRecord) => void,
  onDeleted: (id: string) => void,
) {
  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (disposed) return;
      socket = new WebSocket(HISTORY_WS_URL);
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data));
          if (message.type === "record" && message.record) onRecord(message.record as TranscriptRecord);
          if (message.type === "deleted" && typeof message.id === "string") onDeleted(message.id);
        } catch { /* A malformed event must not break future status updates. */ }
      };
      socket.onclose = () => {
        if (!disposed) reconnectTimer = setTimeout(connect, 3000);
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [onDeleted, onRecord]);
}
