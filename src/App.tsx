import React from 'react';
import { BIMViewer } from './viewer/BIMViewer';
import './App.css';

function App() {
  return (
    <div className="App">
      <BIMViewer />
      <div style={{
        position: 'absolute',
        top: '20px',
        left: '20px',
        zIndex: 100,
        color: 'white',
        background: 'rgba(0,0,0,0.5)',
        padding: '10px',
        borderRadius: '8px',
        fontFamily: 'sans-serif'
      }}>
        <h1>Apex BIM Prototype</h1>
        <p>Engine: Three.js + That Open Components</p>
      </div>
    </div>
  );
}

export default App;
