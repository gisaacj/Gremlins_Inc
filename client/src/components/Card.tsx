import type { ActionCard } from '@gremlins/shared';
import {
  CARD_BY_ID, cardCategory, cardBuildingLabels, cardCostLabel,
  cardHarvestLabel, cardOutcomeLabel, cardTheme, CARD_CATEGORY_ZH,
  cleanGameText, displayCardRules, displayCardName,
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
    /**
     * 说明文案：走显示层处理——替换 `{n}` 占位符、清 `\r` 控制符、
     * 中文缺失或被截断时回退英文。直接用 `card.text.description`
     * 会出现「丢弃{1}张卡牌。」这种带占位符的文案（实测 78/186 张卡）。
     */
    rules: displayCardRules(card),
    name: displayCardName(card),
    flavor: cleanGameText(card.text.flavor ?? ''),
    /**
     * 卡面"特殊规则"角标。
     *
     * 原版 `CChaosCardForm.cs:757` 就是 `this.SpecialIcon.Active = card.SpecialFlag;`
     * —— 纯展示用，**不影响任何逻辑**。它提示玩家"这张牌的规则要特别看"
     * （点开卡牌详情即有完整说明）。
     */
    special: card.special === true,
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

      {/* 「特殊规则」角标（原版 SpecialIcon = SpecialFlag，纯展示） */}
      {d.special && (
        <div className="card-special-icon" title="这张牌有特殊规则，点开查看完整说明">⚙</div>
      )}

      {/* 中间内容 */}
      <div className="card-body">
        <div className="card-name">{d.name}</div>
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
        <h3>{d.name}</h3>
        <div className="card-detail-info">
          {d.cost && <div><b>成本：</b>{d.cost}</div>}
          {d.harvest && <div><b>收获：</b>{d.harvest}</div>}
          {d.outcome && <div><b>代价：</b>{d.outcome}</div>}
        </div>
        {d.rules && <div className="card-detail-rules">{d.rules}</div>}
        {d.flavor && <div className="card-detail-flavor">{d.flavor}</div>}
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
