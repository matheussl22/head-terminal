import { useEffect, useRef } from "react";

interface SearchBarProps {
  query: string;
  onQueryChange: (query: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}

export function SearchBar({
  query,
  onQueryChange,
  onNext,
  onPrevious,
  onClose,
}: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="terminal-search-bar" role="search">
      <input
        ref={inputRef}
        className="terminal-search-bar__input"
        type="search"
        value={query}
        placeholder="Buscar no terminal…"
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (event.shiftKey) {
              onPrevious();
            } else {
              onNext();
            }
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      />
      <button
        type="button"
        className="terminal-search-bar__button"
        title="Anterior (Shift+Enter)"
        onClick={onPrevious}
      >
        ↑
      </button>
      <button
        type="button"
        className="terminal-search-bar__button"
        title="Próximo (Enter)"
        onClick={onNext}
      >
        ↓
      </button>
      <button
        type="button"
        className="terminal-search-bar__button"
        title="Fechar (Esc)"
        onClick={onClose}
      >
        ✕
      </button>
    </div>
  );
}
