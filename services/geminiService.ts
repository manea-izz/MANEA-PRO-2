import { GoogleGenAI, Type, GenerateContentResponse, Part } from "@google/genai";
import { ExtractedData } from '../types';

// A variable to hold the memoized client instance
let ai: GoogleGenAI | null = null;

/**
 * Gets the GoogleGenAI client instance.
 * It checks for the API_KEY environment variable and initializes the client if it hasn't been already.
 * This function is called before any API request to ensure the client is ready.
 * @returns {GoogleGenAI} The initialized GoogleGenAI client.
 * @throws {Error} If the API_KEY environment variable is not set.
 */
const getAiClient = (): GoogleGenAI => {
  if (!process.env.API_KEY) {
    // This error will be caught by the calling function's try...catch block in App.tsx
    throw new Error("لم يتم تعيين مفتاح API. يرجى تكوينه لاستخدام التطبيق.");
  }
  if (!ai) {
    ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  }
  return ai;
};


const dataExtractionSchema = {
  type: Type.OBJECT,
  properties: {
    beneficiaryName: { type: Type.STRING, description: 'اسم المستفيد الكامل' },
    accountNumber: { type: Type.STRING, description: 'رقم حساب المستفيد (IBAN إن وجد)' },
    swiftCode: { type: Type.STRING, description: 'رمز سويفت الخاص بالبنك (SWIFT/BIC)' },
    city: { type: Type.STRING, description: 'المدينة' },
    address: { type: Type.STRING, description: 'العنوان الكامل' },
    bankName: { type: Type.STRING, description: 'اسم البنك' },
    goodsDescription: { type: Type.STRING, description: 'وصف موجز للبضائع أو الخدمات المذكورة في المستند، مثل الفواتير أو بوليصات الشحن.' },
  },
  required: ['beneficiaryName', 'accountNumber', 'swiftCode', 'bankName']
};

export const extractDataFromFile = async (contentPart: Part): Promise<ExtractedData> => {
  const aiClient = getAiClient();
  
  const prompt = `
    أنت خبير متخصص في استخراج البيانات المالية والمصرفية من المستندات والصور بدقة فائقة.
    مهمتك هي تحليل المحتوى المرفق (سواء كان صورة مستند أو نص مستخرج منه) واستخراج المعلومات التالية بصيغة JSON حصرية بناءً على المخطط المحدد.
    - استخرج جميع التفاصيل المصرفية المطلوبة.
    - استخرج وصفاً موجزاً للبضاعة أو الخدمة المذكورة في المستند (مثلاً من فاتورة أو بوليصة شحن).
    يجب أن تبحث عن المعلومات بجميع اللغات الممكنة ومرادفاتها، خاصة العربية والإنجليزية.
    إذا كانت إحدى المعلومات غير متوفرة، اترك الحقل فارغاً أو null.
  `;
  
  const response = await aiClient.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: { parts: [contentPart, { text: prompt }] },
    config: {
      responseMimeType: 'application/json',
      responseSchema: dataExtractionSchema,
    },
  });

  const jsonText = response.text.trim();
  try {
    return JSON.parse(jsonText) as ExtractedData;
  } catch (e) {
    console.error("Failed to parse JSON from Gemini:", jsonText);
    throw new Error("فشل في تحليل البيانات المستخرجة من النموذج.");
  }
};

export const getCompanyInfo = async (companyName: string, bankName: string, goodsDescription?: string): Promise<{ info: string; sources: { uri: string; title: string }[] }> => {
  const aiClient = getAiClient();
  if (!companyName || companyName.trim() === '') {
    return { info: "لم يتم توفير اسم للبحث.", sources: [] };
  }
  
  const prompt = `
    قدم ملخصاً احترافياً وموجزاً عن الشركة المسماة "${companyName}". ركز على تأسيسها ومجال عملها الرئيسي.
    بعد ذلك، أضف معلومة موجزة عن البنك المسمى "${bankName}"، مثل البلد الذي يقع فيه.
    
    ${goodsDescription && goodsDescription.trim() !== '' 
      ? `\nأخيراً، اذكر أن نوع البضاعة المذكورة في الفاتورة هي: "${goodsDescription}". يجب أن يكون هذا الجزء باللغة العربية.`
      : ''}
    
    ادمج كل المعلومات في نص واحد متكامل.
  `;

  const response: GenerateContentResponse = await aiClient.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: {
      tools: [{ googleSearch: {} }],
    },
  });
  
  const info = response.text;
  
  const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const sources = groundingChunks
    .map((chunk) => chunk.web)
    .filter((web) => web?.uri && web.title)
    .map((web) => ({ uri: web!.uri!, title: web!.title! }));

  return { info, sources };
};