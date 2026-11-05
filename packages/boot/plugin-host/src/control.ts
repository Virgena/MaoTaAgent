/// The control plane between the kernel and this host, and the one error code
/// that belongs to it. Nothing here ever reaches a plugin: the kernel refuses
/// `$/host/*` from a frame that carries a plugin id.

export const HOST_METHOD = {
  LOAD: "$/host/load",
  UNLOAD: "$/host/unload",
  KILL: "$/host/kill",
  PING: "$/host/ping",
  LOADING: "$/host/loading",
  EXITED: "$/host/exited",
  FAILED: "$/host/failed",
  CRASH: "$/host/crash",
  STUCK: "$/host/stuck",
  FATAL: "$/host/fatal",
} as const;

export const HOST_FAILED = -32022;
