import { useState, type FormEvent } from 'react';
import { Search, X, FileText } from 'lucide-react';
import type { DocumentRecord } from '../../core/domain/document-source';
import { searchWorkspaceDocuments, type WorkspaceSearchReport, type WorkspaceSearchResult } from './search-service';
import './search.css';

interface Props {
  notes: DocumentRecord[];
  onClose: () => void;
  onOpenResult: (result: WorkspaceSearchResult) => void;
}

export function SearchDialog({ notes, onClose, onOpenResult }: Props) {
  const [query, setQuery] = useState('');
  const [report, setReport] = useState<WorkspaceSearchReport | null>(null);
  const [searching, setSearching] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0, currentTitle: '' });
  const [error, setError] = useState<string | null>(null);

  const runSearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const term = query.trim();
    if (!term || searching) return;
    setSearching(true);
    setError(null);
    setReport(null);
    setProgress({ completed: 0, total: 0, currentTitle: '' });
    try {
      const next = await searchWorkspaceDocuments(notes, term, setProgress);
      setReport(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="workspace-search-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }} onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
      <section className="workspace-search-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-search-title">
        <header className="workspace-search-header">
          <div><Search size={18} /><h2 id="workspace-search-title">Пошук у робочому просторі</h2></div>
          <button type="button" className="icon-button" aria-label="Закрити пошук" onClick={onClose}><X size={18} /></button>
        </header>
        <form className="workspace-search-form" onSubmit={runSearch}>
          <input
            autoFocus
            type="search"
            aria-label="Пошуковий запит"
            placeholder="Текст у нотатках і документах…"
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
          <button type="submit" disabled={!query.trim() || searching}>
            <Search size={15} />Знайти
          </button>
        </form>
        <div className="workspace-search-body" aria-live="polite">
          {searching && (
            <div className="workspace-search-status" role="status">
              <span className="workspace-search-spinner" />
              <span>Перевірено {progress.completed} із {progress.total || '…'} документів{progress.currentTitle ? ': ' + progress.currentTitle : ''}</span>
            </div>
          )}
          {error && <p className="workspace-search-error" role="alert">{error}</p>}
          {report && (
            <>
              <div className="workspace-search-summary">Знайдено: {report.results.length} {report.results.length === 1 ? 'документ' : 'документів'}</div>
              {report.results.length > 0 && (
                <ul className="workspace-search-results">
                  {report.results.map(result => (
                    <li key={result.documentType + ':' + result.documentId}>
                      <button type="button" onClick={() => onOpenResult(result)}>
                        <span className="workspace-search-result-icon"><FileText size={17} /></span>
                        <span className="workspace-search-result-main">
                          <strong>{result.title}</strong>
                          {result.path && <small>{result.path}</small>}
                          <span>{result.snippet}</span>
                        </span>
                        <span className="workspace-search-match-count">{result.matchCount}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {report.results.length === 0 && <p className="workspace-search-empty">Збігів не знайдено.</p>}
              {report.skippedPdfCount > 0 && <p className="workspace-search-note">PDF-файли пропущено ({report.skippedPdfCount}): поточний браузерний переглядач не надає текст документа для індексації. OCR не виконується.</p>}
              {report.errors.length > 0 && <p className="workspace-search-note">Не вдалося прочитати {report.errors.length} документів. {report.errors.slice(0, 3).join('; ')}</p>}
              <p className="workspace-search-note">Пошук охоплює всі локальні Markdown-нотатки та збережені версії підтримуваних документів. Незбережені зміни Office-файлів не включаються.</p>
            </>
          )}
          {!searching && !report && !error && <p className="workspace-search-empty">Введіть фразу для пошуку по всіх локальних нотатках і документах.</p>}
        </div>
      </section>
    </div>
  );
}
