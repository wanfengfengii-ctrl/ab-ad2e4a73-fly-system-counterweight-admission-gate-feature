import { FormEvent, useCallback, useEffect, useState } from 'react';
import { fetchBatten, fetchBattens, submitLoad, transferLoad } from './api';
import type { BattenDetail, BattenSummary, LoadItem } from './types';

interface Feedback {
  kind: 'success' | 'error';
  text: string;
}

export default function App() {
  const [battens, setBattens] = useState<BattenSummary[]>([]);
  const [selected, setSelected] = useState('G-01');
  const [details, setDetails] = useState<Record<string, BattenDetail>>({});
  const [pieceId, setPieceId] = useState('');
  const [weight, setWeight] = useState('');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 待转移配重片：在明细中点击某片的“转移”后设定，确认前不发起任何请求
  const [transferPiece, setTransferPiece] = useState<LoadItem | null>(null);
  const [targetBatten, setTargetBatten] = useState('');

  const detail = details[selected] ?? null;

  // 页面状态永远以数据库为准：挂载与每次登记后都重新拉取。
  // 总览与明细在同一 tick 内一起写入，React 单次提交，不会出现半新半旧的画面。
  const refresh = useCallback(async (battenId: string) => {
    const [list, det] = await Promise.all([fetchBattens(), fetchBatten(battenId)]);
    if (list.status === 200 && det.status === 200) {
      setBattens(list.body.battens);
      setDetails((prev) => ({ ...prev, [battenId]: det.body }));
    }
  }, []);

  // 转移成功后同时刷新两根吊杆的总重、余量与明细；
  // 先取齐总览与两杆明细再一次性写入，避免总览先变、明细后变的短暂不一致。
  const refreshAll = useCallback(async () => {
    const list = await fetchBattens();
    if (list.status !== 200) return;
    const detailResults = await Promise.all(
      list.body.battens.map((b) => fetchBatten(b.batten_id)),
    );
    setBattens(list.body.battens);
    setDetails((prev) => {
      const next = { ...prev };
      detailResults.forEach((res) => {
        if (res.status === 200) next[res.body.batten_id] = res.body;
      });
      return next;
    });
  }, []);

  useEffect(() => {
    void refresh(selected);
  }, [refresh, selected]);

  function selectBatten(battenId: string) {
    setSelected(battenId);
    setTransferPiece(null);
    setFeedback(null);
  }

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

  function startTransfer(load: LoadItem) {
    setFeedback(null);
    setTransferPiece(load);
    const other = battens.find((b) => b.batten_id !== selected);
    setTargetBatten(other?.batten_id ?? '');
  }

  async function confirmTransfer() {
    if (!transferPiece || !targetBatten) return;
    setSubmitting(true);
    try {
      const { body } = await transferLoad(
        selected,
        transferPiece.piece_id,
        targetBatten,
      );
      if (body.accepted) {
        // 接口已给出配重片去向，随后以数据库为准刷新两根吊杆
        setFeedback({ kind: 'success', text: body.message });
        setTransferPiece(null);
      } else {
        setFeedback({ kind: 'error', text: `已拒绝：${body.message}` });
      }
    } catch {
      setFeedback({ kind: 'error', text: '网络错误，无法联系装载裁决服务' });
    } finally {
      setSubmitting(false);
    }
    await refreshAll();
  }

  const otherBattens = battens.filter((b) => b.batten_id !== selected);
  // 待转移的片子可能已被其他终端移走：明细刷新后若不存在则退出转移态
  const transferStillHere =
    transferPiece !== null &&
    (detail?.loads.some((l) => l.load_id === transferPiece.load_id) ?? false);
  const activeTransfer = transferStillHere ? transferPiece : null;

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
            onClick={() => selectBatten(b.batten_id)}
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
          onChange={(e) => selectBatten(e.target.value)}
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

          {activeTransfer && (
            <form
              className="transfer-bar"
              aria-label="转移配重片"
              onSubmit={(e) => {
                e.preventDefault();
                void confirmTransfer();
              }}
            >
              <span>
                转移配重片 <strong>{activeTransfer.piece_id}</strong>
                （{activeTransfer.weight_grams} 克）到
              </span>
              <label htmlFor="target-batten" className="visually-hidden">
                目标吊杆
              </label>
              <select
                id="target-batten"
                value={targetBatten}
                onChange={(e) => setTargetBatten(e.target.value)}
              >
                {otherBattens.map((b) => (
                  <option key={b.batten_id} value={b.batten_id}>
                    {b.batten_id}
                  </option>
                ))}
              </select>
              <button type="submit" disabled={submitting || !targetBatten}>
                确认转移
              </button>
              <button
                type="button"
                className="secondary"
                disabled={submitting}
                onClick={() => setTransferPiece(null)}
              >
                取消
              </button>
            </form>
          )}

          {detail.loads.length === 0 ? (
            <p>暂无已接纳配重片</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>配重片标识</th>
                  <th>重量（克）</th>
                  <th>登记时间</th>
                  <th>
                    <span className="visually-hidden">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail.loads.map((load) => (
                  <tr key={load.load_id}>
                    <td>{load.piece_id}</td>
                    <td>{load.weight_grams}</td>
                    <td className="created-at">
                      {load.created_at
                        ? new Date(load.created_at).toLocaleString('zh-CN', {
                            hour12: false,
                          })
                        : ''}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        aria-label={`转移 ${load.piece_id}`}
                        disabled={submitting || otherBattens.length === 0}
                        onClick={() => startTransfer(load)}
                      >
                        转移
                      </button>
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
