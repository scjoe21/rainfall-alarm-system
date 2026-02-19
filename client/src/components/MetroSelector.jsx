import { useState, useEffect } from 'react';

function MetroSelector({ onSelect }) {
  const [metros, setMetros] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/metros')
      .then(res => res.json())
      .then(data => {
        setMetros(data);
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to load metros:', err);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-20">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-700"></div>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-800 mb-6">광역자치단체 선택</h2>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {metros.map(metro => (
          <button
            key={metro.id}
            onClick={() => onSelect(metro)}
            className="relative bg-white rounded-xl shadow-md hover:shadow-lg p-6 text-center transition-all hover:scale-105 hover:bg-blue-50 border border-gray-200"
          >
            <span className="text-lg font-semibold text-gray-700">{metro.name}</span>
            {metro.alarm_count > 0 && (
              <span className="absolute -top-2 -right-2 bg-red-500 text-white text-xs font-bold rounded-full min-w-[1.25rem] h-5 flex items-center justify-center px-1 alarm-badge">
                {metro.alarm_count}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

export default MetroSelector;
