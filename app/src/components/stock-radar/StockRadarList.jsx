export default function StockRadarList({ items, onSelect }) {
  return (
    <div className="radar-card-list">
      {items.map((item, index) => (
        <button
          key={item.id}
          className={`radar-stock-card${item.active ? " active" : ""}${item.pending ? " pending" : ""}`}
          onClick={() => onSelect(item.entityId)}
        >
          <header className="radar-card-head">
            <span className="radar-card-rank">{String(index + 1).padStart(2, "0")}</span>
            <div className="radar-card-identity">
              <div className="radar-card-title">
                <strong>{item.name}</strong>
                {item.symbol ? <span className="radar-card-symbol">{item.symbol}</span> : null}
                {item.selectionLabel ? (
                  <em className={item.userFocus ? "user-focus" : "curator-pick"}>{item.selectionLabel}</em>
                ) : null}
              </div>
              <span>{item.role}</span>
            </div>
          </header>

          <div className="radar-card-market">
            <div>
              <strong>{item.priceText}</strong>
              <span>成交额&nbsp;&nbsp;{item.turnoverText}</span>
            </div>
            <b className={item.changeClass}>{item.changeText}</b>
          </div>
          <div className="radar-card-verdict">
            <span>{item.verdictLabel}</span>
            <strong>{item.action}</strong>
          </div>
        </button>
      ))}
    </div>
  );
}
