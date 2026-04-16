import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import MiniApp from './miniapp/MiniApp'
import './index.css'

const isMiniApp = window.location.pathname.startsWith('/miniapp');
ReactDOM.createRoot(document.getElementById('root')).render(isMiniApp ? <MiniApp /> : <App />)
window.__BUILD_TS = 1772657500
// cache-bust 1772676180
