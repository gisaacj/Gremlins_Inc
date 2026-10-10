import { useState } from 'react';
import { CHARACTERS, characterAbilities } from '@gremlins/shared';
import { useGameStore } from '../store/game.js';
import {
  getServerUrl, isNativeApp, normalizeServerUrl, setServerUrl,
} from '../net/socket.js';
import '../styles/menu.css';

type Tab = 'solo' | 'create' | 'join';

export function Menu() {
  const connected = useGameStore((s) => s.connected);
  const connectionError = useGameStore((s) => s.connectionError);
  const createRoom = useGameStore((s) => s.createRoom);
  const joinRoom = useGameStore((s) => s.joinRoom);
  const startLocalGame = useGameStore((s) => s.startLocalGame);
  const setError = useGameStore((s) => s.setError);

  const [tab, setTab] = useState<Tab>('solo');

  // 单机设置
  const [soloChar, setSoloChar] = useState(CHARACTERS[0]?.id ?? '');
  const [aiCount, setAiCount] = useState(2);
  const [soloCogs, setSoloCogs] = useState(30);
  const [chaosOn, setChaosOn] = useState(true);

  // 联机设置
  const [name, setName] = useState('');
  const [roomId, setRoomId] = useState('');
  const [targetCogs, setTargetCogs] = useState(30);

  // 服务端地址（移动端必填：原生壳里不能靠 window.location.origin）
  const native = isNativeApp();
  const [serverUrl, setServerUrlInput] = useState(() => {
    const cur = getServerUrl();
    return cur && cur !== '/' ? cur : '';
  });
  const [serverSaved, setServerSaved] = useState(false);

  const handleSaveServer = () => {
    setServerUrl(normalizeServerUrl(serverUrl));
    setServerSaved(true);
    // 保存后会断开旧连接；重新加载一次拿到新连接
    setTimeout(() => window.location.reload(), 300);
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      setError({ code: 'NO_NAME', message: '请输入昵称' });
      return;
    }
    try {
      await createRoom(name.trim(), targetCogs);
    } catch (e) {
      setError({ code: 'CREATE_FAIL', message: (e as Error)?.message ?? '创建失败' });
    }
  };

  const handleJoin = async () => {
    if (!name.trim()) {
      setError({ code: 'NO_NAME', message: '请输入昵称' });
      return;
    }
    if (!roomId.trim()) {
      setError({ code: 'NO_ROOM', message: '请输入房间号' });
      return;
    }
    try {
      await joinRoom(roomId.trim().toUpperCase(), name.trim());
    } catch (e) {
      setError({ code: 'JOIN_FAIL', message: (e as Error)?.message ?? '加入失败' });
    }
  };

  const handleSolo = () => {
    startLocalGame({
      playerName: '我',
      characterId: soloChar,
      aiCount,
      targetCogs: soloCogs,
      chaosEnabled: chaosOn,
    });
  };

  const selected = CHARACTERS.find((c) => c.id === soloChar);

  return (
    <div className="menu">
      <div>
        <div className="menu-title">地精公司</div>
        <div className="menu-subtitle">Gremlins, Inc. · 网页复刻版</div>
      </div>

      <div className="menu-card">
        <div className="menu-tabs">
          <div className={`menu-tab ${tab === 'solo' ? 'active' : ''}`} onClick={() => setTab('solo')}>单机对战</div>
          <div className={`menu-tab ${tab === 'create' ? 'active' : ''}`} onClick={() => setTab('create')}>创建房间</div>
          <div className={`menu-tab ${tab === 'join' ? 'active' : ''}`} onClick={() => setTab('join')}>加入房间</div>
        </div>

        {tab === 'solo' ? (
          <>
            <div className="menu-row">
              <label>选择角色</label>
              <select value={soloChar} onChange={(e) => setSoloChar(e.target.value)}>
                {CHARACTERS.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{String(c.order).padStart(2, '0')} {c.text.name}
                  </option>
                ))}
              </select>
            </div>

            {selected && (
              <div className="solo-ability-preview">
                {characterAbilities(selected).map((a, i) => (
                  <div key={i} className="solo-ability-item">
                    <b>{a.name}</b>
                    <span>{a.description}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="menu-row">
              <label>AI 数量</label>
              <select value={aiCount} onChange={(e) => setAiCount(Number(e.target.value))}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>{n} 个 AI（共 {n + 1} 人）</option>
                ))}
              </select>
            </div>

            <div className="menu-row">
              <label>目标齿轮</label>
              <select value={soloCogs} onChange={(e) => setSoloCogs(Number(e.target.value))}>
                <option value={15}>15（快节奏）</option>
                <option value={30}>30（标准）</option>
                <option value={45}>45（持久战）</option>
              </select>
            </div>

            <div className="menu-row">
              <label>暴乱卡牌</label>
              <label className="toggle-row">
                <input type="checkbox" checked={chaosOn} onChange={(e) => setChaosOn(e.target.checked)} />
                <span>{chaosOn ? '启用' : '禁用'}</span>
              </label>
            </div>

            <button className="primary" onClick={handleSolo}>开始单机对战</button>
            <div className="menu-status">
              浏览器内直接运行引擎与 AI，<b>无需服务端</b>
            </div>
          </>
        ) : (
          <>
            <div className="menu-row">
              <label>昵称</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="输入你的名字"
                maxLength={12}
              />
            </div>

            {tab === 'create' ? (
              <>
                <div className="menu-row">
                  <label>目标齿轮</label>
                  <select value={targetCogs} onChange={(e) => setTargetCogs(Number(e.target.value))}>
                    <option value={15}>15（快节奏）</option>
                    <option value={30}>30（标准）</option>
                    <option value={45}>45（持久战）</option>
                    <option value={60}>60（马拉松）</option>
                  </select>
                </div>
                <div className="menu-row">
                  <label>暴乱卡牌</label>
                  <label className="toggle-row">
                    <input type="checkbox" checked={chaosOn} onChange={(e) => setChaosOn(e.target.checked)} />
                    <span>{chaosOn ? '启用' : '禁用'}</span>
                  </label>
                </div>
                <button className="primary" onClick={handleCreate} disabled={!connected}>
                  创建房间
                </button>
              </>
            ) : (
              <>
                <div className="menu-row">
                  <label>房间号</label>
                  <input
                    type="text"
                    value={roomId}
                    onChange={(e) => setRoomId(e.target.value.toUpperCase())}
                    placeholder="6位房间号"
                    maxLength={6}
                    style={{ letterSpacing: 2 }}
                  />
                </div>
                <button className="primary" onClick={handleJoin} disabled={!connected}>
                  加入房间
                </button>
              </>
            )}

            <div className="menu-row">
              <label>服务器</label>
              <input
                type="text"
                value={serverUrl}
                onChange={(e) => { setServerUrlInput(e.target.value); setServerSaved(false); }}
                placeholder="例如 192.168.1.10:3000"
              />
              <button onClick={handleSaveServer} disabled={!serverUrl.trim()}>
                {serverSaved ? '已保存' : '保存'}
              </button>
            </div>
            <div className="menu-status">
              {native
                ? '移动端需填写运行服务端的电脑 IP 与端口（例如 192.168.1.10:3000）'
                : '浏览器与服务端同源部署时可留空；跨机联机时填写服务端地址'}
            </div>

            <div className={`menu-status ${!connected ? 'warning' : ''}`}>
              <span className={`connected-dot ${connected ? '' : 'off'}`} />
              {connectionError
                ? connectionError
                : connected
                  ? '已连接服务器'
                  : '正在连接服务器...（单机对战不受影响）'}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
