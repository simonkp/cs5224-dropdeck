import ShopView from './ShopView';

/** One static page serves every shop: CloudFront rewrites /s/{slug} to /s/index.html. */
export default function ShopPage() {
  return <ShopView />;
}
