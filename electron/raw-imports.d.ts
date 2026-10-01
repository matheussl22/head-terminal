/** Vite's `?raw` suffix: the file's text, untransformed. */
declare module "*?raw" {
  const content: string;
  export default content;
}
