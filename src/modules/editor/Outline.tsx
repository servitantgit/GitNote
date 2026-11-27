import { useEffect, useMemo, useState } from 'react';
import { ListTree } from 'lucide-react';
import type { DocumentScrollPosition } from './navigation/scroll-position';
import { parseDocumentOutline } from './outline';

interface ScrollController {
  getPosition(): DocumentScrollPosition;
  scrollTo(position: DocumentScrollPosition): void;
  subscribe(listener: (position: DocumentScrollPosition) => void): () => void;
}

interface Props { content: string; coordinator: ScrollController }

export function Outline({ content, coordinator }: Props) {
  const headings = useMemo(() => parseDocumentOutline(content), [content]);
  const [position, setPosition] = useState(coordinator.getPosition);

  useEffect(() => coordinator.subscribe(setPosition), [coordinator]);

  let activeIndex = -1;
  for (let index = 0; index < headings.length; index += 1) {
    if (headings[index].line <= position.line) activeIndex = index;
    else break;
  }

  return (
    <nav className="editor-outline" aria-label="Структура документа">
      <div className="editor-outline-heading"><ListTree size={15} /><span>Зміст</span></div>
      {headings.length === 0
        ? <p className="editor-outline-empty">Заголовків немає</p>
        : <ol>
          {headings.map((heading, index) => (
            <li key={heading.line}>
              <button
                type="button"
                className={'level-' + heading.level + (index === activeIndex ? ' active' : '')}
                aria-current={index === activeIndex ? 'location' : undefined}
                title={heading.text}
                onClick={() => coordinator.scrollTo({ line: heading.line, offset: 0 })}
              >
                {heading.text}
              </button>
            </li>
          ))}
        </ol>}
    </nav>
  );
}