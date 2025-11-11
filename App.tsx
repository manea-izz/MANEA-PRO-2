import React, { useState, useCallback, useEffect } from 'react';
import { extractDataFromFile, getCompanyInfo } from './services/geminiService';
import { ProcessableFile, EnrichedData, ComparisonResult, ExtractedData } from './types';
import { UploadIcon, CheckIcon, CrossIcon, InfoIcon, PdfIcon, ImageIcon, FileIcon, TrashIcon, CopyIcon, ClearIcon, WordIcon, ExcelIcon, TextIcon, WhatsAppIcon, FacebookIcon } from './components/icons';
import Spinner from './components/Spinner';
import { Part } from '@google/genai';

// --- Type declarations for external libraries ---
declare const mammoth: any;
declare const XLSX: any;

// --- File Parsing Helper Functions ---

const toBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = (error) => reject(error);
  });

const toText = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsText(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = (error) => reject(error);
  });
  
const wordToText = async (file: File): Promise<string> => {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return result.value;
};

const excelToText = async (file: File): Promise<string> => {
    const arrayBuffer = await file.arrayBuffer();
    const workbook = XLSX.read(arrayBuffer, { type: 'buffer' });
    let fullText = '';
    workbook.SheetNames.forEach((sheetName: string) => {
      const worksheet = workbook.Sheets[sheetName];
      const sheetText = XLSX.utils.sheet_to_csv(worksheet);
      fullText += `--- ${sheetName} ---\n${sheetText}\n\n`;
    });
    return fullText;
};


const prepareContentPart = async (file: File): Promise<Part> => {
  const { type, name } = file;
  if (type.startsWith('image/') || type === 'application/pdf') {
    const base64 = await toBase64(file);
    return { inlineData: { mimeType: type, data: base64 } };
  } else if (type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || name.endsWith('.docx')) {
    const text = await wordToText(file);
    return { text };
  } else if (type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || name.endsWith('.xlsx') || name.endsWith('.xls')) {
    const text = await excelToText(file);
    return { text };
  } else if (type.startsWith('text/') || name.endsWith('.txt')) {
    const text = await toText(file);
    return { text };
  }
  throw new Error(`نوع الملف غير مدعوم: ${type || name}`);
};

// --- Comparison Helper Functions ---

const compareAccountNumbers = (acc1: string, acc2: string): boolean => {
  if (!acc1 || !acc2) return false;
  const norm1 = acc1.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  const norm2 = acc2.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  if (norm1.length === 0 || norm2.length === 0) return false;
  if (norm1 === norm2) return true;
  const [shorter, longer] = norm1.length < norm2.length ? [norm1, norm2] : [norm2, norm1];
  return longer.endsWith(shorter);
};

const calculateLevenshteinDistance = (a: string, b: string): number => {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j < b.length; j++) matrix[j + 1][0] = j + 1;
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(matrix[j][i - 1] + 1, matrix[j - 1][i] + 1, matrix[j - 1][i - 1] + indicator);
    }
  }
  return matrix[b.length][a.length];
};

const fuzzyMatch = (str1: string, str2: string, tolerance = 0.8): boolean => {
    if (!str1 && !str2) return true;
    if (!str1 || !str2) return false;
    const distance = calculateLevenshteinDistance(str1, str2);
    const maxLength = Math.max(str1.length, str2.length);
    if (maxLength === 0) return true;
    const similarity = 1 - distance / maxLength;
    return similarity >= tolerance;
};

// --- Diffing Logic for Visual Feedback ---
const diffStrings = (oldStr: string, newStr: string): Array<{ value: string; added?: boolean; removed?: boolean }> => {
    const oldChars = Array.from(oldStr);
    const newChars = Array.from(newStr);
    const matrix = Array(oldChars.length + 1).fill(0).map(() => Array(newChars.length + 1).fill(0));

    for (let i = 1; i <= oldChars.length; i++) {
        for (let j = 1; j <= newChars.length; j++) {
            if (oldChars[i - 1] === newChars[j - 1]) {
                matrix[i][j] = matrix[i - 1][j - 1] + 1;
            } else {
                matrix[i][j] = Math.max(matrix[i - 1][j], matrix[i][j - 1]);
            }
        }
    }

    const result = [];
    let i = oldChars.length;
    let j = newChars.length;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldChars[i - 1] === newChars[j - 1]) {
            result.unshift({ value: oldChars[i - 1] });
            i--; j--;
        } else if (j > 0 && (i === 0 || matrix[i][j - 1] >= matrix[i - 1][j])) {
            result.unshift({ value: newChars[j - 1], added: true });
            j--;
        } else if (i > 0 && (j === 0 || matrix[i][j - 1] < matrix[i - 1][j])) {
            result.unshift({ value: oldChars[i - 1], removed: true });
            i--;
        }
    }

    if (result.length === 0) return [];
    const coalesced = [{ ...result[0] }];
    for (let k = 1; k < result.length; k++) {
        const last = coalesced[coalesced.length - 1];
        const current = result[k];
        if (last.added === current.added && last.removed === current.removed) {
            last.value += current.value;
        } else {
            coalesced.push({ ...current });
        }
    }
    return coalesced;
};

const DiffText: React.FC<{ diffResult: ReturnType<typeof diffStrings>; type: 'added' | 'removed' }> = ({ diffResult, type }) => {
    return (
        <span className="font-mono text-sm whitespace-pre-wrap break-all leading-relaxed text-brand-gray-200">
            {diffResult.map((part, index) => {
                if (type === 'added') {
                    if (part.added) return <span key={index} className="bg-green-500/30 text-green-100 rounded">{part.value}</span>;
                    if (!part.removed) return <span key={index}>{part.value}</span>;
                } else { // type === 'removed'
                    if (part.removed) return <span key={index} className="bg-red-500/30 text-red-100 rounded line-through">{part.value}</span>;
                    if (!part.added) return <span key={index}>{part.value}</span>;
                }
                return null;
            })}
        </span>
    );
};

// --- Child Components ---

const DropZone: React.FC<{ onFilesSelect: (files: File[]) => void; multiple: boolean; disabled: boolean; label: string }> = ({ onFilesSelect, multiple, disabled, label }) => {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      onFilesSelect(Array.from(e.target.files));
      e.target.value = '';
    }
  };

  const handleDragEvents = (e: React.DragEvent<HTMLDivElement>, isEntering: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled) setIsDragging(isEntering);
  };
  
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    handleDragEvents(e, false);
    if (!disabled && e.dataTransfer.files?.length) {
      onFilesSelect(Array.from(e.dataTransfer.files));
      e.dataTransfer.clearData();
    }
  };
  
  return (
    <div
      onClick={() => !disabled && fileInputRef.current?.click()}
      onDragEnter={(e) => handleDragEvents(e, true)}
      onDragLeave={(e) => handleDragEvents(e, false)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
      className={`relative w-full p-8 text-center bg-brand-gray-800/50 border-2 border-dashed rounded-xl cursor-pointer transition-all duration-300 ${isDragging ? 'border-brand-blue-light bg-brand-gray-700/50' : 'border-brand-gray-700 hover:border-brand-blue-light'} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <div className="flex flex-col items-center justify-center text-brand-gray-400 pointer-events-none">
        <UploadIcon className="w-12 h-12 text-brand-gray-500 mb-3"/>
        <p className="mt-2 text-lg font-semibold">{label}</p>
        <p className="text-sm">أو اسحب وأفلت الملفات هنا</p>
        <p className="text-xs mt-1 text-brand-gray-500">يمكنك لصق الصور أو المستندات مباشرة</p>
      </div>
      <input 
        ref={fileInputRef}
        type='file' 
        className="hidden" 
        multiple={multiple} 
        onChange={handleFileChange} 
        disabled={disabled} 
        accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"
      />
    </div>
  );
};

const ResultCard: React.FC<{ title: string; data: EnrichedData | null }> = ({ title, data }) => {
    const [copiedSection, setCopiedSection] = useState<'data' | 'info' | null>(null);
    if (!data) return null;
    
    const dataFields: { key: keyof ExtractedData; label: string }[] = [
      { key: 'beneficiaryName', label: 'اسم المستفيد' },
      { key: 'accountNumber', label: 'رقم الحساب' },
      { key: 'swiftCode', label: 'سويفت البنك' },
      { key: 'bankName', label: 'البنك' },
      { key: 'city', label: 'المدينة' },
      { key: 'address', label: 'العنوان' },
    ];
    
    const handleCopy = (section: 'data' | 'info') => {
        if (!data) return;
        const textToCopy = section === 'data'
            ? dataFields.map(({ key, label }) => data[key as keyof ExtractedData] ? `${label}: ${data[key as keyof ExtractedData]}` : null).filter(Boolean).join('\n')
            : data.companyInfo || '';
        if (textToCopy) {
            navigator.clipboard.writeText(textToCopy);
            setCopiedSection(section);
            setTimeout(() => setCopiedSection(null), 2000);
        }
    };
  
    return (
      <div className="bg-brand-gray-800 p-6 rounded-xl shadow-lg w-full h-full flex flex-col">
        <h3 className="text-xl font-bold text-brand-blue-light mb-6">{title}</h3>
        <div>
            <div className="flex justify-between items-center mb-4">
                <h4 className="text-lg font-semibold text-brand-gray-200">البيانات المستخرجة</h4>
                <button onClick={() => handleCopy('data')} className={`flex items-center text-sm px-3 py-1 rounded-md transition-all duration-300 ${copiedSection === 'data' ? 'bg-green-600 text-white' : 'bg-brand-gray-700 hover:bg-brand-gray-600 text-brand-gray-300'}`} disabled={!!copiedSection}>
                    {copiedSection === 'data' ? <CheckIcon /> : <CopyIcon className="h-4 w-4" />}<span className="mr-2">{copiedSection === 'data' ? 'Copied!' : 'Copy'}</span>
                </button>
            </div>
            <div className="space-y-4">
              {dataFields.map(({key, label}) => data[key as keyof ExtractedData] ? (<div key={key}>
                  <p className="text-xs font-semibold text-brand-gray-400 uppercase tracking-wider">{label}</p>
                  <p className="text-brand-gray-100 text-left font-mono">{data[key as keyof ExtractedData]}</p>
              </div>) : null)}
            </div>
        </div>
        {data.companyInfo && (
            <div className="mt-6 pt-6 border-t border-brand-gray-700">
                <div className="flex justify-between items-center mb-2">
                    <h4 className="text-lg font-bold text-brand-blue-light flex items-center"><InfoIcon /><span className="mr-2">معلومات عن المستفيد والبنك</span></h4>
                    <button onClick={() => handleCopy('info')} className={`flex items-center text-sm px-3 py-1 rounded-md transition-all duration-300 ${copiedSection === 'info' ? 'bg-green-600 text-white' : 'bg-brand-gray-700 hover:bg-brand-gray-600 text-brand-gray-300'}`} disabled={!!copiedSection}>
                        {copiedSection === 'info' ? <CheckIcon /> : <CopyIcon className="h-4 w-4" />}<span className="mr-2">{copiedSection === 'info' ? 'Copied!' : 'Copy'}</span>
                    </button>
                </div>
                <p className="text-sm text-brand-gray-300 whitespace-pre-wrap">{data.companyInfo}</p>
                {data.sources?.length && (
                    <div className="mt-4"><h5 className="text-xs font-semibold text-brand-gray-400 mb-2">المصادر:</h5><div className="flex flex-wrap gap-2">
                        {data.sources.map((s, i) => <a key={i} href={s.uri} target="_blank" rel="noopener noreferrer" className="text-xs bg-brand-gray-700 hover:bg-brand-blue-light text-brand-gray-200 px-2 py-1 rounded-full transition-colors">{s.title}</a>)}
                    </div></div>
                )}
            </div>
        )}
      </div>
    );
};

const ComparisonView: React.FC<{ result: ComparisonResult | null }> = ({ result }) => {
    const [showDiff, setShowDiff] = useState(true);
    if (!result) return null;

    const dataFields: { key: keyof ExtractedData; label: string }[] = [
        { key: 'beneficiaryName', label: 'اسم المستفيد' },
        { key: 'accountNumber', label: 'رقم الحساب' },
        { key: 'swiftCode', label: 'سويفت البنك' },
        { key: 'bankName', label: 'البنك' },
    ];
    
    const fieldMap = dataFields.reduce((acc, field) => {
        acc[field.key] = field.label;
        return acc;
    }, {} as Record<string, string>);

    return (
        <div className="mt-8 bg-brand-gray-800/50 p-4 sm:p-6 rounded-xl shadow-lg w-full col-span-1 md:col-span-2 border border-brand-gray-700/50">
            <div className="flex justify-between items-center mb-6">
                <h3 className="text-xl font-bold text-brand-blue-light">نتائج المطابقة</h3>
                <div className="flex items-center">
                    <span className="text-sm text-brand-gray-300 mr-3">إظهار الاختلافات</span>
                    <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" checked={showDiff} onChange={() => setShowDiff(!showDiff)} className="sr-only peer" />
                        <div className="w-11 h-6 bg-brand-gray-600 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-brand-blue"></div>
                    </label>
                </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {Object.entries(result).map(([key, res]) => {
                    if (!fieldMap[key] || (!res.value1 && !res.value2)) return null;
                    const diffResult = showDiff && !res.match ? diffStrings(res.value1, res.value2) : null;
                    return (
                       <div key={key} className={`p-4 rounded-lg border transition-all ${res.match ? 'border-brand-gray-700 bg-brand-gray-800/50' : 'border-red-500/30 bg-red-900/20'}`}>
                            <div className="flex justify-between items-center mb-3">
                                <span className="font-semibold text-sm text-brand-gray-200">{fieldMap[key]}</span>
                                {res.match ? <CheckIcon /> : <CrossIcon />}
                            </div>
                            <div className="space-y-3">
                                <div>
                                    <label className="text-xs text-brand-gray-500 mb-1 block">الملف 1</label>
                                    <div className="p-2 bg-brand-gray-900/50 rounded min-h-[40px] flex items-center">
                                        {diffResult ? <DiffText diffResult={diffResult} type="removed" /> : <span className="font-mono text-sm whitespace-pre-wrap break-all text-brand-gray-200">{res.value1}</span>}
                                    </div>
                                </div>
                                <div>
                                    <label className="text-xs text-brand-gray-500 mb-1 block">الملف 2</label>
                                    <div className="p-2 bg-brand-gray-900/50 rounded min-h-[40px] flex items-center">
                                        {diffResult ? <DiffText diffResult={diffResult} type="added" /> : <span className="font-mono text-sm whitespace-pre-wrap break-all text-brand-gray-200">{res.value2}</span>}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )
                })}
            </div>
        </div>
    );
};

// --- Main App Component ---

function App() {
  const [singleFile, setSingleFile] = useState<File | null>(null);
  const [processableFiles, setProcessableFiles] = useState<ProcessableFile[]>([]);
  const [singleResult, setSingleResult] = useState<EnrichedData | null>(null);
  const [comparisonResult, setComparisonResult] = useState<ComparisonResult | null>(null);
  const [multiFileResults, setMultiFileResults] = useState<ExtractedData[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'single' | 'multi'>('single');

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      if (isLoading) return;
      const files = Array.from(event.clipboardData?.files || []);
      if (files.length > 0) {
        handleFilesSelected(files);
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [activeTab, isLoading]);

  const handleFilesSelected = (files: File[]) => {
      setError(null);
      if (activeTab === 'single') {
        setSingleFile(files[0]);
        setSingleResult(null);
      } else {
        const newProcessableFiles = files.map(file => ({ file, status: 'pending' as const, id: `${file.name}-${Date.now()}` }));
        setProcessableFiles(prev => [...prev, ...newProcessableFiles]);
        setComparisonResult(null);
      }
  };

  const handleClear = () => {
    setError(null);
    if (activeTab === 'single') {
      setSingleFile(null);
      setSingleResult(null);
    } else {
      setProcessableFiles([]);
      setComparisonResult(null);
      setMultiFileResults([]);
    }
  };

  const handleRemoveMultiFile = (idToRemove: string) => {
    setProcessableFiles(files => files.filter(f => f.id !== idToRemove));
  };

  const handleProcessSingleFile = useCallback(async () => {
    if (!singleFile) return;
    setIsLoading(true);
    setError(null);
    setSingleResult(null);
    try {
      const contentPart = await prepareContentPart(singleFile);
      const extractedData = await extractDataFromFile(contentPart);
      const { info, sources } = await getCompanyInfo(extractedData.beneficiaryName, extractedData.bankName, extractedData.goodsDescription);
      setSingleResult({ ...extractedData, companyInfo: info, sources });
    } catch (err: any) {
      setError(err.message || 'حدث خطأ غير متوقع.');
    } finally {
      setIsLoading(false);
    }
  }, [singleFile]);
  
  const handleProcessMultiFile = useCallback(async () => {
    const filesToProcess = processableFiles.filter(pf => pf.status === 'pending');
    if (filesToProcess.length === 0 && processableFiles.filter(pf => pf.status === 'done').length < 2) {
      setError("يرجى رفع ملفين على الأقل للمطابقة.");
      return;
    }
    setIsLoading(true);
    setError(null);

    const processingPromises = processableFiles.map(async (pf) => {
        if (pf.status === 'done' && pf.data) return pf.data;
        if (pf.status === 'processing' || pf.status === 'error') return null; // Don't re-process
        
        setProcessableFiles(prev => prev.map(f => f.id === pf.id ? { ...f, status: 'processing' } : f));
        
        try {
            const part = await prepareContentPart(pf.file);
            const data = await extractDataFromFile(part);
            setProcessableFiles(prev => prev.map(f => f.id === pf.id ? { ...f, status: 'done', data } : f));
            return data;
        } catch (err: any) {
            setProcessableFiles(prev => prev.map(f => f.id === pf.id ? { ...f, status: 'error', error: err.message } : f));
            return null;
        }
    });

    const allResults = await Promise.all(processingPromises);
    const successfulResults = processableFiles.filter(pf => pf.status === 'done' && pf.data).map(pf => pf.data!);

    if (successfulResults.length >= 2) {
        const [data1, data2] = successfulResults;
        const comparison: Partial<ComparisonResult> = {};
        const allKeys = new Set([...Object.keys(data1), ...Object.keys(data2)]) as Set<keyof ExtractedData>;
        
        allKeys.forEach(key => {
            const val1 = data1[key] || '';
            const val2 = data2[key] || '';
            let isMatch = false;
            if (key === 'beneficiaryName' || key === 'bankName') isMatch = fuzzyMatch(val1, val2, 0.7);
            else if (key === 'goodsDescription') isMatch = fuzzyMatch(val1, val2, 0.8);
            else if (key === 'accountNumber') isMatch = compareAccountNumbers(val1, val2);
            else isMatch = (val1 || '').toLowerCase().replace(/[\s.-]/g, '') === (val2 || '').toLowerCase().replace(/[\s.-]/g, '');
            comparison[key] = { value1: val1, value2: val2, match: isMatch };
        });
        setComparisonResult(comparison as ComparisonResult);
        setMultiFileResults(successfulResults);
    } else {
      setMultiFileResults(successfulResults);
      if (processableFiles.some(f => f.status === 'error')) {
        setError("فشلت معالجة أحد الملفات. يرجى التحقق والمحاولة مرة أخرى.");
      }
    }
    setIsLoading(false);
  }, [processableFiles]);
  
  const getFileIcon = (file: File) => {
    const { type, name } = file;
    if (type.startsWith('image/')) return <ImageIcon />;
    if (type === 'application/pdf') return <PdfIcon />;
    if (type.includes('word') || name.endsWith('.docx')) return <WordIcon />;
    if (type.includes('excel') || type.includes('spreadsheet') || name.endsWith('.xlsx') || name.endsWith('.xls')) return <ExcelIcon />;
    if (type.startsWith('text/') || name.endsWith('.txt')) return <TextIcon />;
    return <FileIcon />;
  };

  const renderStatusIndicator = (status: ProcessableFile['status']) => {
    switch (status) {
        case 'processing': return <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-brand-blue-light"></div>;
        case 'done': return <CheckIcon />;
        case 'error': return <CrossIcon />;
        default: return <div className="h-4 w-4"></div>; // Placeholder for pending
    }
  };

  return (
    <div className="min-h-screen text-brand-gray-100 p-4 sm:p-8 flex flex-col">
      <header className="text-center mb-10">
        <h1 className="text-4xl sm:text-5xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-brand-blue-light to-brand-blue">مانع برو</h1>
        <p className="text-lg text-brand-gray-400 mt-2">أداة فحص واستخراج البيانات الذكية</p>
      </header>
      <main className="flex-grow w-full max-w-6xl mx-auto bg-brand-gray-800/20 p-4 sm:p-8 rounded-2xl border border-brand-gray-700/50 shadow-2xl shadow-black/20">
        <div className="flex justify-center mb-8 bg-brand-gray-800 p-1 rounded-full w-fit mx-auto">
            {['single', 'multi'].map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab as any)} className={`px-6 py-2 text-md font-medium transition-colors rounded-full ${activeTab === tab ? 'bg-brand-blue text-white' : 'text-brand-gray-400 hover:text-white'}`}>
                {tab === 'single' ? 'فحص ملف واحد' : 'مطابقة الملفات'}
              </button>
            ))}
        </div>
        {error && <p className="text-red-400 my-4 text-center bg-red-900/30 p-3 rounded-lg max-w-2xl mx-auto">{error}</p>}
        {activeTab === 'single' ? (
             <div className="w-full max-w-2xl mx-auto">
                <div className="flex flex-col items-center gap-4">
                    <DropZone onFilesSelect={handleFilesSelected} multiple={false} disabled={isLoading || !!singleFile} label="اختر ملفًا"/>
                    {singleFile && <div className="flex items-center justify-between w-full max-w-md bg-brand-gray-700/50 px-4 py-2 rounded-lg border border-brand-gray-700 animate-slide-in-fade-in">
                        <div className="flex items-center gap-3 overflow-hidden">{getFileIcon(singleFile)}<span className="text-sm text-brand-gray-300 truncate" title={singleFile.name}>{singleFile.name}</span></div>
                        <button onClick={() => setSingleFile(null)} className="text-gray-400 hover:text-red-400 p-1 rounded-full hover:bg-red-500/10"><TrashIcon className="h-4 w-4" /></button>
                    </div>}
                    <div className="w-full flex items-stretch gap-2">
                        <button onClick={handleProcessSingleFile} disabled={!singleFile || isLoading} className="flex-grow bg-brand-blue hover:bg-brand-blue-light text-white font-bold py-3 px-4 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed">{isLoading ? <Spinner/> : 'فحص واستخراج البيانات'}</button>
                        {(singleResult || error || singleFile) && !isLoading && <button onClick={handleClear} className="flex-shrink-0 bg-brand-gray-700 hover:bg-brand-gray-600 text-white font-bold p-3 rounded-lg transition-colors"><ClearIcon/></button>}
                    </div>
                </div>
                {singleResult && <div className="mt-8 animate-slide-in-fade-in"><ResultCard title="البيانات المستخرجة" data={singleResult} /></div>}
            </div>
        ) : (
             <div className="w-full max-w-4xl mx-auto">
                <div className="flex flex-col items-center gap-4">
                    <DropZone onFilesSelect={handleFilesSelected} multiple={true} disabled={isLoading} label="اختر ملفين أو أكثر"/>
                    {processableFiles.length > 0 && <div className="w-full p-2"><div className="flex flex-wrap justify-center items-center gap-3">
                        {processableFiles.map(pf => (
                            <div key={pf.id} className="flex items-center bg-brand-gray-700/50 pl-3 pr-1 py-1 rounded-full border border-brand-gray-700 animate-slide-in-fade-in" title={pf.error}>
                                {renderStatusIndicator(pf.status)}
                                <div className="mx-2">{getFileIcon(pf.file)}</div>
                                <span className="mr-2 ml-1 text-xs truncate max-w-[150px] sm:max-w-xs" title={pf.file.name}>{pf.file.name}</span>
                                <button onClick={() => handleRemoveMultiFile(pf.id)} className="text-gray-400 hover:text-red-400 bg-brand-gray-600/50 rounded-full p-1 hover:bg-red-500/20"><TrashIcon className="h-3 w-3" /></button>
                            </div>
                        ))}
                    </div></div>}
                    <div className="w-full flex items-stretch gap-2">
                        <button onClick={handleProcessMultiFile} disabled={processableFiles.length < 2 || isLoading} className="flex-grow bg-brand-blue hover:bg-brand-blue-light text-white font-bold py-3 px-4 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed">{isLoading ? <Spinner/> : 'مطابقة الملفات'}</button>
                        {(comparisonResult || error || processableFiles.length > 0) && !isLoading && <button onClick={handleClear} className="flex-shrink-0 bg-brand-gray-700 hover:bg-brand-gray-600 text-white font-bold p-3 rounded-lg transition-colors"><ClearIcon/></button>}
                    </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-8">
                    {multiFileResults.slice(0, 2).map((result, index) => <div key={index} className="animate-slide-in-fade-in"><ResultCard title={`بيانات الملف ${index + 1}`} data={result} /></div>)}
                    {comparisonResult && <div className="animate-slide-in-fade-in md:col-span-2"><ComparisonView result={comparisonResult} /></div>}
                </div>
                
            </div>
        )}
      </main>
      <footer className="text-center mt-12 text-sm text-brand-gray-600">
        <p>تم التطوير بواسطة مانع عزالدين عبر تقنيات الذكاء الاصطناعي المتقدمة.</p>
        <div className="flex justify-center items-center gap-4 mt-4">
            <a href="https://wa.me/967772655825" target="_blank" rel="noopener noreferrer" className="text-brand-gray-400 hover:text-green-500 transition-colors">
                <WhatsAppIcon />
            </a>
            <a href="https://www.facebook.com/9l7iz" target="_blank" rel="noopener noreferrer" className="text-brand-gray-400 hover:text-blue-500 transition-colors">
                <FacebookIcon />
            </a>
        </div>
      </footer>
    </div>
  );
}

export default App;