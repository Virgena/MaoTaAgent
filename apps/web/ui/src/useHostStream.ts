import { useEffect, useRef } from "react";

import { subscribe, type HostEvent } from "./lib/rpc.ts";

export function useHostStream({
  onEvent,
  onReconnect,
}: {
  onEvent: (event: HostEvent) => void;
  onReconnect: () => void;
}) {
  const eventRef = useRef(onEvent);
  const reconnectRef = useRef(onReconnect);
  useEffect(() => {
    eventRef.current = onEvent;
  }, [onEvent]);
  useEffect(() => {
    reconnectRef.current = onReconnect;
  }, [onReconnect]);
  useEffect(
    () => subscribe(
      (event: HostEvent) => eventRef.current(event),
      () => reconnectRef.current(),
    ),
    [],
  );
}
