/*
 * The icon slot — every icon of the interface comes from here, never straight
 * from `lucide-react`.
 *
 * Each export is the Lucide line icon, with two things added on its `<svg>`:
 * the `mf-icon` hook and a `data-icon` name. That is all a theme needs to
 * bring its own artwork, from its stylesheet alone:
 *
 *   [data-theme='vista'] .mf-icon[data-icon='reply'] {
 *     background-image: url('./vista-icons/reply.svg');
 *   }
 *
 * plus one shared rule that sets `stroke: none` on the icons it has drawn, so
 * the line icon underneath is not painted. An icon a theme has not drawn stays
 * the Lucide one: a set can be partial, and a new icon never comes out blank.
 *
 * Like the other `mf-*` hooks, `mf-icon` carries no style in the original
 * theme. Staying in CSS keeps a theme a stylesheet, and makes the artwork
 * follow `data-theme` on any element — the previews of `ThemeModal` included.
 *
 * Artwork is a picture: it cannot follow `currentColor`. An icon whose state
 * is told by its color says it with `data-on` as well (the follow-up star).
 */
import { useBusyCursor } from '../lib/busyCursor';
import {
  AlertCircle as LucideAlertCircle,
  Archive as LucideArchive,
  Ban as LucideBan,
  Baseline as LucideBaseline,
  Bold as LucideBold,
  Check as LucideCheck,
  ChevronRight as LucideChevronRight,
  Database as LucideDatabase,
  Download as LucideDownload,
  ExternalLink as LucideExternalLink,
  EyeOff as LucideEyeOff,
  FileText as LucideFileText,
  Folder as LucideFolder,
  FolderDown as LucideFolderDown,
  Forward as LucideForward,
  HelpCircle as LucideHelpCircle,
  GripHorizontal as LucideGripHorizontal,
  Highlighter as LucideHighlighter,
  Image as LucideImage,
  ImageOff as LucideImageOff,
  Inbox as LucideInbox,
  Italic as LucideItalic,
  Lightbulb as LucideLightbulb,
  LightbulbOff as LucideLightbulbOff,
  Link as LucideLink,
  Link2Off as LucideLink2Off,
  Loader2 as LucideLoader2,
  Minus as LucideMinus,
  Moon as LucideMoon,
  Palette as LucidePalette,
  Paperclip as LucidePaperclip,
  PenSquare as LucidePenSquare,
  RefreshCw as LucideRefreshCw,
  RemoveFormatting as LucideRemoveFormatting,
  Reply as LucideReply,
  ReplyAll as LucideReplyAll,
  Search as LucideSearch,
  Send as LucideSend,
  ShieldAlert as LucideShieldAlert,
  ShieldOff as LucideShieldOff,
  Star as LucideStar,
  Strikethrough as LucideStrikethrough,
  Sun as LucideSun,
  Trash2 as LucideTrash2,
  Underline as LucideUnderline,
  UserPlus as LucideUserPlus,
  Users as LucideUsers,
  X as LucideX,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react';
import { cn } from '../lib/utils';

export type IconProps = LucideProps & {
  /** The icon shows an active state (a flagged message): themes may draw it differently. */
  'data-on'?: boolean;
};

function slot(Glyph: LucideIcon, name: string) {
  function Icon({ className, ...props }: IconProps) {
    return <Glyph {...props} data-icon={name} className={cn('mf-icon', className)} />;
  }
  Icon.displayName = `Icon(${name})`;
  return Icon;
}

export const AlertCircle = slot(LucideAlertCircle, 'alert-circle');
export const Archive = slot(LucideArchive, 'archive');
export const Ban = slot(LucideBan, 'ban');
export const Baseline = slot(LucideBaseline, 'baseline');
export const Bold = slot(LucideBold, 'bold');
export const Check = slot(LucideCheck, 'check');
export const ChevronRight = slot(LucideChevronRight, 'chevron-right');
export const Database = slot(LucideDatabase, 'database');
export const Download = slot(LucideDownload, 'download');
export const ExternalLink = slot(LucideExternalLink, 'external-link');
export const EyeOff = slot(LucideEyeOff, 'eye-off');
export const FileText = slot(LucideFileText, 'file-text');
export const Folder = slot(LucideFolder, 'folder');
export const FolderDown = slot(LucideFolderDown, 'folder-down');
export const Forward = slot(LucideForward, 'forward');
export const HelpCircle = slot(LucideHelpCircle, 'help-circle');
export const GripHorizontal = slot(LucideGripHorizontal, 'grip-horizontal');
export const Highlighter = slot(LucideHighlighter, 'highlighter');
export const Image = slot(LucideImage, 'image');
export const ImageOff = slot(LucideImageOff, 'image-off');
export const Inbox = slot(LucideInbox, 'inbox');
export const Italic = slot(LucideItalic, 'italic');
export const Lightbulb = slot(LucideLightbulb, 'lightbulb');
export const LightbulbOff = slot(LucideLightbulbOff, 'lightbulb-off');
export const Link = slot(LucideLink, 'link');
export const Link2Off = slot(LucideLink2Off, 'link-2-off');
const Loader2Glyph = slot(LucideLoader2, 'loader-2');

/** Only ever drawn while something loads, so it also raises the busy cursor. */
export function Loader2(props: IconProps) {
  useBusyCursor();
  return <Loader2Glyph {...props} />;
}
export const Minus = slot(LucideMinus, 'minus');
export const Moon = slot(LucideMoon, 'moon');
export const Palette = slot(LucidePalette, 'palette');
export const Paperclip = slot(LucidePaperclip, 'paperclip');
export const PenSquare = slot(LucidePenSquare, 'pen-square');
export const RefreshCw = slot(LucideRefreshCw, 'refresh-cw');
export const RemoveFormatting = slot(LucideRemoveFormatting, 'remove-formatting');
export const Reply = slot(LucideReply, 'reply');
export const ReplyAll = slot(LucideReplyAll, 'reply-all');
export const Search = slot(LucideSearch, 'search');
export const Send = slot(LucideSend, 'send');
export const ShieldAlert = slot(LucideShieldAlert, 'shield-alert');
export const ShieldOff = slot(LucideShieldOff, 'shield-off');
export const Star = slot(LucideStar, 'star');
export const Strikethrough = slot(LucideStrikethrough, 'strikethrough');
export const Sun = slot(LucideSun, 'sun');
export const Trash2 = slot(LucideTrash2, 'trash-2');
export const Underline = slot(LucideUnderline, 'underline');
export const UserPlus = slot(LucideUserPlus, 'user-plus');
export const Users = slot(LucideUsers, 'users');
export const X = slot(LucideX, 'x');
