import type { ActionCard } from '@gremlins/shared';
import {
  CARD_BY_ID, cardCategory, cardBuildingLabels, cardCostLabel,
  cardHarvestLabel, cardOutcomeLabel, cardTheme, CARD_CATEGORY_ZH,
} from '@gremlins/shared';

interface CardProps {
  cardId: string;
  selected?: boolean;
  disabled?: boolean;
  highlight?: boolean;
  onClick?: () => void;
  onLongPress?: () => void;
  compact?: boolean;
}

/** 按原版旗标决定底色 */
function kindBgClass(card: ActionCard): string {
  const cat = cardCategory(card);
  if (cat === 'secret') return 'card-bg-secret';
  if (cat === 'criminal') return 'card-bg-criminal';
  if (cat === 'permanent') return 'card-bg-permanent';
  return 'card-bg-regular';
}

/** 卡面用到的主要信息，都是从权威数据派生出来的 */
function useCardDisplay(card: ActionCard) {
  return {
    bg: kindBgClass(card),
    places: cardBuildingLabels(card),
    cost: cardCostLabel(card),
    harvest: cardHarvestLabel(card),
    outcome: cardOutcomeLabel(card),
    category: CARD_CATEGORY_ZH[cardCategory(card)],
    theme: cardTheme(card),
    /** 原文说明（中文），比 OCR 拼接的字段更完整 */
    rules: card.text.description,
  };
}

export function Card({ cardId, selected, disabled, highlight, onClick, onLongPress }: CardProps) {
  const card = CARD_BY_ID[cardId] as ActionCard | undefined;
  if (!card) return null;
  const d = useCardDisplay(card);

  return (
    <div
      className={`card ${d.bg} ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''} ${highlight ? 'card-highlight' : ''}`}
      onClick={disabled ? undefined : onClick}
      onDoubleClick={onLongPress}
    >
      {/* 左上角：移动点数 */}
      <div className={`card-move ${card.move === 0 ? 'zero' : ''}`}>
        {card.move > 0 ? card.move : '✕'}
      </div>

      {/* 右上角：可用地点 */}
      {d.places.length > 0 && (
        <div className="card-building">{d.places.join('/')}</div>
      )}

      {/* 中间内容 */}
      <div className="card-body">
        <div className="card-name">{card.text.name}</div>
        {d.cost && <div className="card-line card-cost-line">成本 {d.cost}</div>}
        {d.harvest && <div className="card-line card-harvest-line">收获 {d.harvest}</div>}
        {d.outcome && <div className="card-line card-outcome-line">代价 {d.outcome}</div>}
        {d.rules && <div className="card-line card-rules-line">{d.rules}</div>}
      </div>

      {/* 左下角：类型标记 */}
      {(card.permanent || card.secret || card.criminal) && (
        <div className={`card-kind kind-${cardCategory(card)}`}>{d.category}</div>
      )}
    </div>
  );
}

export function CardDetail({
  cardId, onPlay, onClose, canPlay = true, playLabel = '打出', requireTarget = false, targetOptions = [],
}: {
  cardId: string;
  onPlay?: (targetId?: string) => void;
  onClose: () => void;
  canPlay?: boolean;
  playLabel?: string;
  requireTarget?: boolean;
  targetOptions?: { id: string; name: string }[];
}) {
  const card = CARD_BY_ID[cardId] as ActionCard | undefined;
  if (!card) return null;
  const d = useCardDisplay(card);

  return (
    <div className="card-detail-overlay" onClick={onClose}>
      <div className={`card-detail ${d.bg}`} onClick={(e) => e.stopPropagation()}>
        <div className="card-detail-header">
          <span className="card-detail-move">移动 {card.move}</span>
          {d.places.length > 0 && (
            <span className="card-detail-building">{d.places.join(' / ')}</span>
          )}
          <span className="card-detail-kind">{d.category}</span>
        </div>
        <h3>{card.text.name}</h3>
        <div className="card-detail-info">
          {d.cost && <div><b>成本：</b>{d.cost}</div>}
          {d.harvest && <div><b>收获：</b>{d.harvest}</div>}
          {d.outcome && <div><b>代价：</b>{d.outcome}</div>}
        </div>
        {d.rules && <div className="card-detail-rules">{d.rules}</div>}
        {card.text.flavor && <div className="card-detail-flavor">{card.text.flavor}</div>}
        {requireTarget && (
          <div className="card-detail-targets">
            <div style={{ fontSize: 12, marginBottom: 4 }}>选择目标：</div>
            {targetOptions.length === 0 && (
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>无可用目标</div>
            )}
            {targetOptions.map((t) => (
              <button key={t.id} onClick={() => onPlay?.(t.id)} disabled={!canPlay}>{t.name}</button>
            ))}
          </div>
        )}
        <div className="card-detail-actions">
          {onPlay && !requireTarget && (
            <button className="primary" onClick={() => onPlay()} disabled={!canPlay}>{playLabel}</button>
          )}
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
