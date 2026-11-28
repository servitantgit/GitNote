import { File, FileCode, FileImage, FileSpreadsheet, FileText, FileType, Presentation } from 'lucide-react';

interface Props {
  name: string;
  size?: number;
}

export function WorkspaceFileIcon({ name, size = 15 }: Props) {
  const extension = name.split('.').pop()?.toLowerCase();
  if (['md', 'markdown', 'txt'].includes(extension ?? '')) return <FileText size={size} color="#4385D1" />;
  if (extension === 'docx') return <FileType size={size} color="#3478C8" />;
  if (extension === 'xlsx' || extension === 'csv') return <FileSpreadsheet size={size} color="#278653" />;
  if (extension === 'pptx') return <Presentation size={size} color="#D58A35" />;
  if (extension === 'pdf') return <FileText size={size} color="#D14B4B" />;
  if (['html', 'htm', 'svg'].includes(extension ?? '')) return <FileCode size={size} color="#8B63C7" />;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico'].includes(extension ?? '')) return <FileImage size={size} color="#A16BB8" />;
  return <File size={size} />;
}
