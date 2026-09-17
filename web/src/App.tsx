import { FormEvent, useCallback, useEffect, useState } from 'react';
import { fetchBatten, fetchBattens, submitLoad, transferLoad } from './api';
import type { BattenDetail, BattenSummary } from './types';

interface Feedback {
  kind: 'success' | 'error';
  text: string;
}

export default function App() {
  const [battens, setBattens] = useState<BattenSummary[]>([]);
  const [selected, setSelected] = useState('G-01');
  const [detail, setDetail] = useState<BattenDetail | null>(null);
  const [pieceId, setPieceId] = useState('');
  const [weight, setWeight] = useState('');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 正在确认转移的配重片标识及其目标吊杆
  const [movingPiece, setMovingPiece] = useState<string | null>(null);
  const [transferTarget, setTransferTarget] = useState('');
  const [transferring, setTransferring] = useState(false);

  // 页面状态永远以数据库为准：挂载与每次登记后都重新拉取
  const refresh = useCallback(async (battenId: string) => {
    const [list, det] = await Promise.all([fetchBattens(), fetchBatten(battenId)]);
    if (list.status === 200) {
      setBattens(list.body.battens);
    }
    if (det.status === 200) {
      setDetail(det.body);
    } else {
      setDetail(null);
    }
  }, []);

  useEffect(() => {
    void refresh(selected);
  }, [refresh, selected]);

  // 切换吊杆时取消未确认的转移选择
  useEffect(() => {
    setMovingPiece(null);
  }, [selected]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFeedback(null);
    const trimmedId = pieceId.trim();
    const trimmedWeight = weight.trim();
    // 按原始输入严格判定整数：字符串 "100.0"、"1e2" 等一律在页面明确拒绝
    if (!trimmedId || !/^-?\d+$/.test(trimmedWeight)) {
      setFeedback({ kind: 'error', text: '请输入配重片标识，重量必须是整数克数' });
      return;
    }
    const grams = Number(trimmedWeight);
    setSubmitting(true);
    try {
      const { body } = await submitLoad(selected, trimmedId, grams);
      if (body.accepted) {
        setFeedback({
          kind: 'success',
          text: `${body.message}：当前总重 ${body.total_grams} 克，剩余量 ${body.remaining_grams} 克`,
        });
        setPieceId('');
        setWeight('');
      } else {
        setFeedback({ kind: 'error', text: `已拒绝：${body.message}` });
      }
    } catch {
      setFeedback({ kind: 'error', text: '网络错误，无法联系装载裁决服务' });
    } finally {
      setSubmitting(false);
    }
    await refresh(selected);
  }

  function startTransfer(piece: string) {
    setFeedback(null);
    setTransferTarget(
      battens.find((b) => b.batten_id !== selected)?.batten_id ?? '',
    );
    setMovingPiece(piece);
  }

  async function handleTransfer(piece: string) {
    if (!transferTarget) return;
    setFeedback(null);
    setTransferring(true);
    try {
      const { body } = await transferLoad(selected, piece, transferTarget);
      if (body.accepted) {
        // 反馈中给出配重片去向与两根吊杆的最新余量
        const summary = [body.from, body.to]
          .filter((s): s is BattenSummary => Boolean(s))
          .map((s) => `${s.batten_id} 剩余 ${s.remaining_grams} 克`)
          .join('，');
        setFeedback({
          kind: 'success',
          text: summary ? `${body.message}：${summary}` : body.message,
        });
      } else {
        setFeedback({ kind: 'error', text: `已拒绝：${body.message}` });
      }
    } catch {
      setFeedback({ kind: 'error', text: '网络错误，无法联系装载裁决服务' });
    } finally {
      setTransferring(false);
      setMovingPiece(null);
    }
    // 无论成败都重新拉取：两根吊杆的总重、余量与明细以数据库为准
    await refresh(selected);
  }

  return (
    <main className="page">
      <h1>剧场吊杆配重装载台</h1>

      <section aria-label="吊杆总览" className="cards">
        {battens.map((b) => (
          <button
            key={b.batten_id}
            type="button"
            className={b.batten_id === selected ? 'card selected' : 'card'}
            aria-pressed={b.batten_id === selected}
            onClick={() => setSelected(b.batten_id)}
          >
            <strong>{b.batten_id}</strong>
            <span>核定 {b.capacity_grams} 克</span>
            <span>总重 {b.total_grams} 克</span>
            <span>剩余 {b.remaining_grams} 克</span>
          </button>
        ))}
      </section>

      <form className="load-form" noValidate onSubmit={handleSubmit}>
        <label htmlFor="batten-select">选择吊杆</label>
        <select
          id="batten-select"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          {battens.map((b) => (
            <option key={b.batten_id} value={b.batten_id}>
              {b.batten_id}
            </option>
          ))}
        </select>

        <label htmlFor="piece-id">配重片标识</label>
        <input
          id="piece-id"
          value={pieceId}
          placeholder="例如 CW-0001"
          onChange={(e) => setPieceId(e.target.value)}
        />

        <label htmlFor="weight">重量（克）</label>
        <input
          id="weight"
          type="text"
          inputMode="numeric"
          value={weight}
          placeholder="100 ~ 25000 的整数"
          onChange={(e) => setWeight(e.target.value)}
        />

        <button type="submit" disabled={submitting}>
          登记装载
        </button>
      </form>

      {feedback && (
        <p
          role={feedback.kind === 'error' ? 'alert' : 'status'}
          className={`feedback ${feedback.kind}`}
        >
          {feedback.text}
        </p>
      )}

      {detail && (
        <section aria-label="吊杆明细" className="detail">
          <h2>{detail.batten_id} 当前状态</h2>
          <dl className="stats">
            <div>
              <dt>核定重量</dt>
              <dd>{detail.capacity_grams} 克</dd>
            </div>
            <div>
              <dt>当前总重</dt>
              <dd data-testid="total">{detail.total_grams} 克</dd>
            </div>
            <div>
              <dt>剩余量</dt>
              <dd data-testid="remaining">{detail.remaining_grams} 克</dd>
            </div>
          </dl>
          {detail.loads.length === 0 ? (
            <p>暂无已接纳配重片</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>配重片标识</th>
                  <th>重量（克）</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {detail.loads.map((load) => (
                  <tr key={load.load_id}>
                    <td>{load.piece_id}</td>
                    <td>{load.weight_grams}</td>
                    <td>
                      {movingPiece === load.piece_id ? (
                        <span className="transfer-controls">
                          <select
                            aria-label="目标吊杆"
                            value={transferTarget}
                            onChange={(e) => setTransferTarget(e.target.value)}
                          >
                            {battens
                              .filter((b) => b.batten_id !== detail.batten_id)
                              .map((b) => (
                                <option key={b.batten_id} value={b.batten_id}>
                                  {b.batten_id}
                                </option>
                              ))}
                          </select>
                          <button
                            type="button"
                            disabled={transferring || !transferTarget}
                            onClick={() => void handleTransfer(load.piece_id)}
                          >
                            确认转移
                          </button>
                          <button
                            type="button"
                            disabled={transferring}
                            onClick={() => setMovingPiece(null)}
                          >
                            取消
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => startTransfer(load.piece_id)}
                        >
                          转移
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </main>
  );
}
