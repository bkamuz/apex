import { createRoot } from 'react-dom/client';
import App from './App';
import { I18nProvider } from './i18n';
import './styles/app.css';
import './styles/palette.css';
import { themeStore } from './theme/theme';

// Apply the persisted / system theme before first paint.
themeStore();

createRoot(document.getElementById('root')!).render(
  <I18nProvider>
    <App />
  </I18nProvider>,
);
