export function truncatePathMiddle(path: string, maxLength = 28): string {
  if (path.length <= maxLength) {
    return path;
  }

  const headLength = Math.ceil((maxLength - 1) / 2);
  const tailLength = Math.floor((maxLength - 1) / 2);

  return `${path.slice(0, headLength)}…${path.slice(-tailLength)}`;
}
