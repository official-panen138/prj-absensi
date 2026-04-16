export default function Modal({ open, onClose, title, children, width = 'max-w-lg' }) {
  if (!open) return null;

  return (
    <div
      onClick={(e) => e.target === e.currentTarget && onClose()}
      className="fixed inset-0 z-[8000] bg-black/75 backdrop-blur-sm flex items-end md:items-center justify-center p-0 md:p-5"
    >
      <div className={`bg-gray-900 border border-gray-700 w-full ${width} max-h-[90vh] overflow-auto animate-fade-in shadow-2xl rounded-t-2xl md:rounded-xl`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <span className="font-bold text-[15px]">{title}</span>
          <button onClick={onClose} className="bg-transparent border-none text-gray-500 text-xl cursor-pointer hover:text-gray-300">&times;</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
