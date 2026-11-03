import test from 'node:test';
import assert from 'node:assert/strict';
import { filterCommands, type PaletteCommand } from '../src/ui/commands.ts';

const cmd = (id: string, label: string, search: string, shortcut?: string): PaletteCommand => ({
  id, label, search, group: 'g', shortcut, run: () => {},
});
const cmds = [
  cmd('wall', 'Стена', 'wall стена place:apex.wall', 'WA'),
  cmd('door', 'Дверь', 'door дверь', 'DR'),
  cmd('thin', 'Тонкие линии', 'thin lines тонкие линии', 'TL'),
  cmd('save', 'Сохранить', 'save сохранить', 'Ctrl+S'),
];

test('palette finds RU and EN spellings', () => {
  assert.equal(filterCommands(cmds, 'wall')[0]?.id, 'wall');
  assert.equal(filterCommands(cmds, 'сте')[0]?.id, 'wall');
  assert.equal(filterCommands(cmds, 'ЛИНИИ тон')[0]?.id, 'thin');
});

test('palette shortcut query ranks the command first', () => {
  assert.equal(filterCommands(cmds, 'dr')[0]?.id, 'door');
  assert.equal(filterCommands(cmds, 'xyz').length, 0);
  assert.equal(filterCommands(cmds, '').length, 4);
});
