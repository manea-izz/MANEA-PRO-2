
export interface ExtractedData {
  beneficiaryName: string;
  accountNumber: string;
  swiftCode: string;
  city: string;
  address: string;
  bankName: string;
  goodsDescription?: string;
}

export interface EnrichedData extends ExtractedData {
  companyInfo?: string;
  sources?: { uri: string; title: string }[];
}

export type ProcessingStatus = 'pending' | 'processing' | 'done' | 'error';

export interface ProcessableFile {
  id: string; // Unique ID for key prop
  file: File;
  status: ProcessingStatus;
  data?: ExtractedData;
  error?: string;
}

export type ComparisonResult = {
  [K in keyof ExtractedData]: {
    value1: string;
    value2: string;
    match: boolean;
  }
};