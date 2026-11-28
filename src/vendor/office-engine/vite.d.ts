/// <reference types="vite/client" />

declare module '*?worker&inline' {
  const workerConstructor: {
    new (options?: WorkerOptions): Worker;
  };
  export default workerConstructor;
}

declare module '*.css?inline' {
  const css: string;
  export default css;
}
