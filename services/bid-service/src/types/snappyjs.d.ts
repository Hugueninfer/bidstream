declare module 'snappyjs' {
  export function compress<T extends Buffer | Uint8Array | ArrayBuffer>(input: T): T;
  export function uncompress<T extends Buffer | Uint8Array | ArrayBuffer>(input: T, maxLength?: number): T;
}
