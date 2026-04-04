import { BIMViewer } from './viewer/BIMViewer';
import styles from './App.module.css';

function App() {
  return (
    <div className="App">
      <BIMViewer />
      <div className={styles.infoOverlay}>
        <h1>Apex BIM Prototype</h1>
        <p>Engine: Three.js + That Open Components</p>
      </div>
    </div>
  );
}

export default App;
