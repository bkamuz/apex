/**
 * Read and write a `.apexgenus` file. The desktop shell uses a native
 * dialog; the browser downloads / picks a file.
 */
import { isTauriShell, openTextFileDesktop, saveTextFileDesktop } from '../desktop/projectIo';
import { downloadText } from '../persist';

const FILTERS = [{ name: 'Apex genus', extensions: ['apexgenus'] }];

export async function writeGenusFile(filename: string, text: string): Promise<boolean> {
  if (isTauriShell()) {
    const saved = await saveTextFileDesktop(text, { suggestedName: filename, forcePicker: true, filters: FILTERS });
    return saved !== null;
  }
  downloadText(filename, text, 'application/json');
  return true;
}

export function readGenusFileFromBrowser(): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.apexgenus,application/json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      void file.text().then((text) => resolve({ name: file.name, text }));
    };
    input.click();
  });
}

export async function readGenusFile(): Promise<{ name: string; text: string } | null> {
  if (isTauriShell()) {
    const opened = await openTextFileDesktop(FILTERS);
    return opened ? { name: opened.name, text: opened.text } : null;
  }
  return readGenusFileFromBrowser();
}
