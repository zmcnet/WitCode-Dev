import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme, loadTheme } from './theme';
import './styles.css';

// 首屏前先落主题，避免深色闪一下再变浅。
applyTheme(loadTheme());

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(<App />);
