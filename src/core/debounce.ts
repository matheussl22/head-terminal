export interface DebouncedFunction<T extends (...args: never[]) => void> {
  (...args: Parameters<T>): void;
  flush: () => void;
  cancel: () => void;
}

export function debounce<T extends (...args: never[]) => void>(
  fn: T,
  ms: number,
): DebouncedFunction<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: Parameters<T> | null = null;

  const debounced = ((...args: Parameters<T>) => {
    pendingArgs = args;
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      if (pendingArgs !== null) {
        fn(...pendingArgs);
        pendingArgs = null;
      }
    }, ms);
  }) as DebouncedFunction<T>;

  debounced.flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pendingArgs !== null) {
      fn(...pendingArgs);
      pendingArgs = null;
    }
  };

  debounced.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pendingArgs = null;
  };

  return debounced;
}
