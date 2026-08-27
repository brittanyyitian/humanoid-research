import { Search } from "lucide-react";

export default function StockRadarToolbar({
  activeSector,
  onSearchChange,
  onSectorChange,
  searchTerm,
  sectorOptions,
}) {
  return (
    <section className="stock-radar-toolbar">
      <div className="radar-sector-switch" aria-label="选择股票方向">
        {sectorOptions.map((option) => (
          <button
            key={option.id}
            className={activeSector === option.id ? "active" : ""}
            onClick={() => onSectorChange(option.id)}
          >
            {option.label}<span>{option.count}</span>
          </button>
        ))}
      </div>
      <div className="change-search">
        <Search size={16} />
        <input
          value={searchTerm}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="搜索股票 / 代码 / 公司业务"
          aria-label="搜索股票雷达"
        />
      </div>
      <div className="radar-filter-note">按 Serenity 综合跟踪价值排序</div>
    </section>
  );
}
