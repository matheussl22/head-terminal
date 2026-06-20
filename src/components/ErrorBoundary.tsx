import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
  info: ErrorInfo | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ info });
    this.props.onError?.(error, info);
  }

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "#0a0a0a",
          color: "#fd6f6b",
          padding: "24px",
          font: "13px/1.5 monospace",
          overflow: "auto",
          whiteSpace: "pre-wrap",
        }}
      >
        <h1 style={{ color: "#fff", fontSize: "16px", marginBottom: "12px" }}>
          Head Terminal — erro de renderização
        </h1>
        <strong>{error.message}</strong>
        {"\n\n"}
        {error.stack}
        {info?.componentStack ? `\n\nComponentes:\n${info.componentStack}` : ""}
      </div>
    );
  }
}
