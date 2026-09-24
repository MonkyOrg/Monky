declare module '*?url' {
  const url: string;
  export default url;
}

declare module '*?url&no-inline' {
  const url: string;
  export default url;
}

declare module '*?worker' {
  const WorkerConstructor: new () => Worker;
  export default WorkerConstructor;
}
