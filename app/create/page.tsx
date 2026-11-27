import { PostStudio } from '../../components/post-studio/PostStudio';

export default async function CreatePage({
  searchParams,
}: {
  searchParams: Promise<{ postId?: string }>;
}) {
  const sp = await searchParams;
  return <PostStudio initialPostId={sp.postId} />;
}
