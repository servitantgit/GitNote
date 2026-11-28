import { type KeyboardEvent, type MouseEvent } from 'react';
import { Settings, X } from 'lucide-react';
import type { AppPreferences } from './preferences';
import './settings.css';

interface Props {
  preferences: AppPreferences;
  onChange: (preferences: AppPreferences) => void;
  onClose: () => void;
}

export function SettingsDialog({ preferences, onChange, onClose }: Props) {
  function update<K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) {
    onChange({ ...preferences, [key]: value });
  }
  const checkbox = (key: 'lineWrapping' | 'lineNumbers' | 'outlineOpenByDefault' | 'minimapOpenByDefault' | 'restoreTabs' | 'rememberSidebarState', label: string) => (
    <label className="settings-check" key={key}>
      <input type="checkbox" checked={preferences[key]} onChange={event => update(key, event.target.checked)} />
      <span>{label}</span>
    </label>
  );
  const closeOnBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') onClose();
  };

  return (
    <div className="settings-backdrop" onMouseDown={closeOnBackdrop} onKeyDown={handleKeyDown}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings-header">
          <div><Settings size={18} /><h2 id="settings-title">Налаштування</h2></div>
          <button type="button" className="icon-button" aria-label="Закрити налаштування" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="settings-body">
          <section className="settings-section" aria-labelledby="settings-appearance">
            <h3 id="settings-appearance">Оформлення</h3>
            <label className="settings-field"><span>Тема інтерфейсу</span>
              <select aria-label="Тема інтерфейсу" value={preferences.theme} onChange={event => update('theme', event.target.value as AppPreferences['theme'])}>
                <option value="system">Як у системі</option><option value="light">Світла</option><option value="dark">Темна</option><option value="black">Black (OLED)</option>
              </select>
            </label>
            <label className="settings-field"><span>Щільність інтерфейсу</span>
              <select aria-label="Щільність інтерфейсу" value={preferences.density} onChange={event => update('density', event.target.value as AppPreferences['density'])}>
                <option value="comfortable">Звичайна</option><option value="compact">Компактна</option>
              </select>
            </label>
          </section>
          <section className="settings-section" aria-labelledby="settings-editor">
            <h3 id="settings-editor">Редактор Markdown</h3>
            <label className="settings-field"><span>Режим за замовчуванням</span>
              <select aria-label="Режим Markdown за замовчуванням" value={preferences.defaultMode} onChange={event => update('defaultMode', event.target.value as AppPreferences['defaultMode'])}>
                <option value="source">Source</option><option value="live">Live</option><option value="preview">Preview</option>
              </select>
            </label>
            <label className="settings-field"><span>Розмір шрифту редактора</span>
              <select aria-label="Розмір шрифту редактора" value={String(preferences.editorFontSize)} onChange={event => update('editorFontSize', Number(event.target.value))}>
                {[12,13,14,15,16,17,18].map(size => <option key={size} value={size}>{size} px</option>)}
              </select>
            </label>
            
            {checkbox('lineWrapping', 'Переносити довгі рядки')}
            {checkbox('lineNumbers', 'Показувати номери рядків')}
            {checkbox('outlineOpenByDefault', 'Автоматично відкривати зміст')}
            {checkbox('minimapOpenByDefault', 'Автоматично відкривати мінімапу')}
          </section>
          <section className="settings-section" aria-labelledby="settings-workspace">
            <h3 id="settings-workspace">Робочий простір</h3>
            {checkbox('restoreTabs', 'Відновлювати відкриті вкладки після запуску')}
            {checkbox('rememberSidebarState', 'Запам’ятовувати стан бічної панелі')}
            <p className="settings-note">Якщо відновлення вкладок вимкнене, документи залишаються у сховищі, але попередні вкладки не відкриваються автоматично.</p>
          </section>
        </div>
      </section>
    </div>
  );
}
