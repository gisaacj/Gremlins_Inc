import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';
// 移动端适配放在最后引入，确保窄屏媒体查询能覆盖前面的规则
import './styles/mobile.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
