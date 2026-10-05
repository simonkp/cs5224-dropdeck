import DropView from './DropView';

/** One static page serves every drop: CloudFront rewrites /d/{tenant}/{drop} to /d/index.html. */
export default function DropPage() {
  return <DropView />;
}
